"""Loopback-only fixture proxy/collector; it never forwards to the network."""
import base64
import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

output = pathlib.Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
page = b'''<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Guest fixture</title><style>body{margin:0}input{position:absolute;left:20px;top:60px;width:240px;height:40px}</style>
<form><label for="name">Customer</label><input id="name"><button style="position:absolute;left:20px;top:140px">Save customer</button></form><output style="position:absolute;left:20px;top:200px"></output><script>window.nonce=crypto.randomUUID?crypto.randomUUID():String(Math.random());window.trusted=false;document.querySelector('input').addEventListener('input',e=>window.trusted=e.isTrusted);document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();window.submitted=e.isTrusted;localStorage.setItem('customer',document.querySelector('input').value);document.querySelector('output').textContent='Saved '+localStorage.getItem('customer')})</script>'''


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        with (output / 'proxy-requests.txt').open('a') as log:
            log.write(self.path + '\n')
        if self.path != 'http://fixture.invalid/page':
            self.send_error(502, 'Fixture refuses other destinations')
            return
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        name = self.path.removeprefix('/evidence/')
        if self.path != '/evidence/' + name or name not in {
            'opened', 'ax', 'input', 'screenshot', 'evalException', 'closed',
            'retained', 'reopened', 'stale', 'death', 'passed', 'failure',
            'backgroundScreenshot', 'returnedScreenshot', 'background', 'presented', 'returned', 'reload', 'storage', 'isolated', 'beforeReload'
        }:
            self.send_error(400)
            return
        size = int(self.headers.get('Content-Length', '0'))
        if size <= 0 or size > 1000000:
            self.send_error(413)
            return
        data = json.loads(self.rfile.read(size))
        (output / (name + '.json')).write_text(json.dumps(data, indent=2))
        if name in {'screenshot', 'backgroundScreenshot', 'returnedScreenshot'}:
            (output / (name + '.png')).write_bytes(base64.b64decode(data['data']))
        self.send_response(200)
        self.end_headers()


ThreadingHTTPServer(('127.0.0.1', 18779), Handler).serve_forever()
