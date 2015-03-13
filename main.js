var _config = {};

/*CONFIG*/
_config["chat_timeout"] = 3; //The amount of time in which timeout_msg_num messages can be sent before the user is kicked.
_config["timeout_msg_num"] = 5; //Number of messages within chat_timeout before being kicked.
_config["server_root"] = __dirname ;
_config["max_msg_length"] = 1500;

//Include our requirements
var readline = require('readline');
var express = require('express');
var app = express();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var FixedQueue = require('./inc/fqueue.js');
var auth_lib = require("./inc/auth.js");
var user_lib = require("./inc/users.js");
var command_lib = require("./inc/commands.js");
var Entities = require('html-entities').XmlEntities;
entities = new Entities();

var chat_history = FixedQueue.FixedQueue(20); //Use a fixed queue to store the chat history.
var users = []; //Holds a list of user sockets
var user_info = []; //Holds information on each socket such as nickname, spam time out stuff, etc.

app.use(express.static(__dirname + '/web')); //serve web directory

/*
 * Runs every 1 second for timed things such as spam time outs.
*/
function chat_tick()
{
	
	for(var i = 0; i < users.length; i++)
	{
		if(!users[i]){
			continue;
		}
		
		//The chat timeout is used to kick users for spamming multiple messages within a [chat_timeout] second period.
		user_info[users[i].id]["chat_timeout"]++;
		if(user_info[users[i].id]["chat_timeout"] >= _config["chat_timeout"])
		{
			//Time up, reset timeout info.
			//Wouldn't want to kick everyone who thinks to type 5 messages in a session!
			user_info[users[i].id]["chat_timeout"] = 0;
			user_info[users[i].id]["num_messages"] = 0;

		}
	}
}
setInterval(chat_tick, 1000);

/*
 * Initializes the user_info entry for a user socket.
*/
function init_socket(socket)
{
	users.push(socket);
	
	//console.log(socket.id);
	user_info[socket.id] = {};
	user_info[socket.id]["chat_timeout"] = 0;
	user_info[socket.id]["num_messages"] = 0;
}

/*
 * Gets a socket from a nickname or returns false if there isn't one.
*/
function get_user(nick)
{
	for (var i in user_info) 
		if(user_info[i] && user_info[i]["nickname"])
			return i;
	
	return false;
}


/*
 * Sends the chat history to a user.
*/
function send_history(socket)
{
	socket.emit("CHAT_HISTORY", chat_history);
}
function remove_user(socket)
{
	//Remove the socket stored for the user
	var i = users.indexOf(socket);
	delete users[i];
}

//Create urls in chat.
function urlify(text) {
    var urlRegex = /(https?:\/\/[^\s]+)/g;
    return text.replace(urlRegex, function(url) {
        return '<a target="_blank" href="' + url + '">' + url + '</a>';
    })
}

/*
 * Called when a new chat message is received.
*/
function on_message(socket, msg)
{
	//checks there is info for the user.
	//If not, kick them because they probably aren't authenticated.
	if(!user_info[socket.id] || !user_info[socket.id]["nickname"])
	{
		user_lib.KickUser(user_info, socket, "Not authenticated.");
		remove_user(socket);
		return;
	}
	
	//Add onto the time out message count.
	user_info[socket.id]["chat_timeout"] = 0;
	user_info[socket.id]["num_messages"]++;
	if(user_info[socket.id]["num_messages"] >= _config["timeout_msg_num"])
	{
		user_lib.KickUser(user_info, socket, "Kicked for chat spam."); //Kick them for spam if they posted too many messages too fast.
		remove_user(socket);
		return;
	}
	
	//Check if message is command.
	isCommand = false;

	if(msg.charAt(0) == "/")
	 isCommand = true;
	
	msg = entities.encode(msg);

	msg = urlify(msg);
	
	//Add the message to the chat history
	chat_history.push([user_info[socket.id]["nickname"], msg]);
	
	//And of course send it to all the other clients
	if(!isCommand)
		io.sockets.emit('CHAT_MSG', user_info[socket.id]["nickname"], msg);
	
	if(isCommand)
	{
		if(command_lib.isPublic(msg))
		{
			io.sockets.emit('CHAT_MSG', user_info[socket.id]["nickname"], msg);
			io.sockets.emit('CHAT_MSG', "Server", command_lib.executeCommand(msg, io));			
		}
		else
		{
			chat_history.push([user_info[socket.id]["nickname"], msg]);
			socket.emit('CHAT_MSG', user_info[socket.id]["nickname"], msg);
			chat_history.push(["Server", msg]);
			socket.emit('CHAT_MSG', "Server", command_lib.executeCommand(msg, io));
		}
			
	}
		
}

/*
 * Called when someone sends a private message.
*/
function on_pmessage(socket, nick, msg)
{
	//checks there is info for the user.
	//If not, kick them because they probably aren't authenticated.
	if(!user_info[socket.id] || !user_info[socket.id]["nickname"])
	{
		user_lib.KickUser(user_info, socket, "Not authenticated.");
		remove_user(socket);
		return;
	}
	
	//Add onto the time out message count.
	user_info[socket.id]["chat_timeout"] = 0;
	user_info[socket.id]["num_messages"]++;
	if(user_info[socket.id]["num_messages"] >= _config["timeout_msg_num"])
	{
		user_lib.KickUser(user_info, socket, "Kicked for chat spam."); //Kick them for spam if they posted too many messages too fast.
		remove_user(socket);
		return;
	}
	
	//Trim the message if it is too long.
	if(msg.length > _config["max_msg_length"])
		msg = msg.substr(1, _config["max_msg_length"]) + "..."; //Add 3 dots on the end because why not.
	
	msg = entities.encode(msg);
	
	var csock = get_user(nick);
	if(!csock)
	{
		socket.emit("MSG_ERROR", "PM_NONICK", nick);
		return;
	}
	
	//send it to the other guy
	csock.emit('CHAT_PMSG', user_info[socket.id]["nickname"], msg);
}

//User connections
io.on('connection', function(socket)
{
	//Call the socket init to initialize the user info.
	init_socket(socket);
	
	//A socket was disconnected.
	socket.on('disconnect', function()
	{
		//Check the socket wasn't intentionally disconnected by the server.
		if(!socket.kicked && user_info[socket.id]["nickname"])
		{	
			//If it wasn't, tell everyone they disconnected then remove their info.
			io.emit('USR_DISCONNECT', user_info[socket.id]["nickname"]);
			user_info[socket.id] = null;
			
			var i = users.indexOf(socket);
			delete users[i];
		}
	});
	
	socket.on('CHAT_MSG', function(msg)
	{
		on_message(socket, msg); //send chat messages to our on_message function.
	});
	socket.on('CHAT_PMSG', function(to, msg)
	{
		on_pmessage(socket, to, msg);
	});
	
	//User asked if they are authenticated. If not, they were probably reconnected.
	socket.on('HAS_AUTH', function()
	{
		//No nick name means they didn't auth! Better tell em off.
		if(!user_info[socket.id]["nickname"])
			socket.emit("HAS_AUTH", false);
		
		socket.emit("HAS_AUTH", true);
	});
	
	//User sent a login request
	socket.on('AUTH_LOGIN', function(nick, pass)
	{
		var nick = auth_lib.checkAuth(user_info, socket, nick, pass);
		user_info[socket.id]["nickname"] = nick;
		
		//If the login was successful, send them the chat history and tell everyone else they joined.
		if(nick)
		{
			socket.broadcast.emit('USR_CONNECT', user_info[socket.id]["nickname"]);
			send_history(socket);
		}
	});
	
	//User asked for the nick list.
	socket.on('NICK_LIST', function()
	{
		var nlist = [];
		for(var i = 0; i < users.length; i++)
		{
			//If the socket has a nickname, append it to nlist
			if(users[i] && user_info[users[i].id]["nickname"])
			{
				var nick = user_info[users[i].id]["nickname"];
				
				//Make a certain nick red like some kind of admin.
				//Probably should use this with the authenticated nicks exampled in auth.js.
				var col = (auth_lib.isAdmin(nick)) ? "<span style='color: darkred;' title='Admin'>"+nick+"</span>" : nick; 
				
				nlist.push(col);
			}
		}
		
		//Send them their nick list.
		socket.emit("NICK_LIST", nlist);
		
	});
	
});

//HTTP!
http.listen(3120, function()
{
	console.log('listening on *:3120'); //totally obviously most important line of code
});

function args_string(args, start)
{
	var out = "";
	for(var i = start; i < args.length; i++)
		out += args[i] + " ";
	return out;
}

//console input
var rl = readline.createInterface(
{
	input: process.stdin,
	output: process.stdout
});
rl.on('line', function (cmdc) 
{
	var args = cmdc.split(" ");
	var cmd = args[0];
	
	if(cmd == "chistory")
	{
		chat_history = FixedQueue.FixedQueue(20);
		console.log("CMD: Chat history cleared.");
	}
	else if(cmd == "sendmsg")
		io.emit("CHAT_MSG", "Server", args_string(args, 1));
	else if(cmd == "sendpmsg")
	{
		var usr = get_user(args[1]);
		if(!usr)
			console.log("Error: user '"+args[1]+"' not found.");
		else
			usr.emit("CHAT_PMSG", "Server", args_string(args, 2));
	}
	else if(cmd == "help")
		console.log("Commands: chistory(Clears chat history), sendmsg [msg](Sends a message to everyone), sendpmsg [nick] [msg](Sends a private message to the user)");
	else if(cmd == "exit")
	{
		io.emit("SERVER_SHUTDOWN");
		rl.close();
		process.exit(0);
	}
});
console.log("Type 'help' for a command list.");