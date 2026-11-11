# No-cost stand-in for the Anthropic Messages API (checkpoints-vm.ts uploads it to the VM and runs it
# at 127.0.0.1:8998). Claude Code uses it as its model, so a chat turn is real Claude Code with real
# tools and no model spend:
#   - a user message containing "RUN: <bash>" gets one Bash tool_use running that command;
#   - a tool_result gets the text "DONE";
#   - anything else (titles, side calls) gets a short text.
# Each request is logged to /tmp/standin.log with the "Turn X." markers in the model's context, which
# shows whether a rewind also rewound what the agent sees.
import http.server, json, re, time, uuid

LOG = '/tmp/standin.log'


def log(line):
    with open(LOG, 'a') as f:
        f.write(time.strftime('%H:%M:%S ') + line + '\n')


def texts(content):
    if isinstance(content, str):
        return [content]
    return [b.get('text', '') for b in (content or []) if isinstance(b, dict) and b.get('type') == 'text']


def decide(body):
    messages = body.get('messages') or []
    if not body.get('tools') or not messages:
        return ('text', 'ok')
    content = messages[-1].get('content')
    if isinstance(content, list) and any(isinstance(b, dict) and b.get('type') == 'tool_result' for b in content):
        return ('text', 'DONE')
    for text in reversed(texts(content)):
        if 'RUN:' in text:
            return ('tool', text.split('RUN:', 1)[1].split('\n', 1)[0].strip())
    return ('text', 'DONE')


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def reply(self, obj, content_type='application/json'):
        data = obj if isinstance(obj, bytes) else json.dumps(obj).encode()
        self.send_response(200)
        self.send_header('content-type', content_type)
        self.send_header('content-length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self.reply({'data': [], 'has_more': False})

    def do_POST(self):
        size = int(self.headers.get('content-length') or 0)
        try:
            body = json.loads(self.rfile.read(size) or b'{}')
        except ValueError:
            body = {}
        if 'count_tokens' in self.path:
            return self.reply({'input_tokens': 10})
        kind, value = decide(body)
        model = body.get('model', 'claude-standin')
        messages = body.get('messages') or []
        context = [t for m in messages for text in texts(m.get('content')) for t in re.findall(r'Turn ([A-Z])[.]', text)]
        log(f'POST {self.path} tools={len(body.get("tools") or [])} msgs={len(messages)} context={context} -> {kind} {value[:160]}')
        usage = {'input_tokens': 10, 'output_tokens': 5, 'cache_creation_input_tokens': 0, 'cache_read_input_tokens': 0}
        if kind == 'tool':
            block = {'type': 'tool_use', 'id': 'toolu_' + uuid.uuid4().hex[:20], 'name': 'Bash',
                     'input': {'command': value, 'description': 'Scripted edit'}}
            stop = 'tool_use'
        else:
            block = {'type': 'text', 'text': value}
            stop = 'end_turn'
        message_id = 'msg_' + uuid.uuid4().hex[:20]
        if not body.get('stream'):
            return self.reply({'id': message_id, 'type': 'message', 'role': 'assistant', 'model': model, 'content': [block],
                               'stop_reason': stop, 'stop_sequence': None, 'usage': usage})
        events = [('message_start', {'type': 'message_start', 'message': {
            'id': message_id, 'type': 'message', 'role': 'assistant', 'model': model, 'content': [],
            'stop_reason': None, 'stop_sequence': None, 'usage': usage}})]
        if kind == 'tool':
            events.append(('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {**block, 'input': {}}}))
            events.append(('content_block_delta', {'type': 'content_block_delta', 'index': 0,
                                                   'delta': {'type': 'input_json_delta', 'partial_json': json.dumps(block['input'])}}))
        else:
            events.append(('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}}))
            events.append(('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': value}}))
        events.append(('content_block_stop', {'type': 'content_block_stop', 'index': 0}))
        events.append(('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': stop, 'stop_sequence': None}, 'usage': {'output_tokens': 5}}))
        events.append(('message_stop', {'type': 'message_stop'}))
        self.reply(b''.join(f'event: {name}\ndata: {json.dumps(data)}\n\n'.encode() for name, data in events), 'text/event-stream')


http.server.ThreadingHTTPServer(('127.0.0.1', 8998), Handler).serve_forever()
