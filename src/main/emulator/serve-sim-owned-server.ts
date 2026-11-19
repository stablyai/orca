// The public middleware lets the OS allocate the listening port without serve-sim's port-killing CLI.
export const SERVE_SIM_OWNED_SERVER = `
const { createServer } = require('node:http');
(async () => {
  const { simMiddleware } = await import(process.argv[1]);
  const device = process.argv[2];
  const token = '/' + process.argv[3];
  const prefix = token + '/helper/' + device + '/';
  const middleware = simMiddleware({ basePath: '/', device });
  const route = req => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/api/event-log') {
        url.searchParams.set('device', device);
        req.url = url.pathname + url.search;
        return true;
      }
      if (!url.pathname.startsWith(prefix)) return false;
      req.url = url.pathname.slice(token.length) + url.search;
      return true;
    } catch { return false; }
  };
  const server = createServer((req, res) => {
    if (!route(req)) { res.writeHead(404); res.end(); return; }
    Promise.resolve(middleware(req, res)).catch(() => { res.destroy(); });
  });
  server.on('upgrade', (req, socket, head) => {
    if (!route(req)) { socket.destroy(); return; }
    middleware.handleUpgrade(req, socket, head);
  });
  server.listen(0, '127.0.0.1', () => console.log('ORCA_PORT:' + server.address().port));
  process.stdin.resume();
  process.stdin.on('end', () => process.exit(0));
})().catch(error => { console.error(error); process.exit(1); });
`
