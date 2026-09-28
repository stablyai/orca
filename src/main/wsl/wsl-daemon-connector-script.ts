export const WSL_DAEMON_CONNECTOR_READY = 'ORCA_WSL_DAEMON_CONNECTED\n'

/** No shell or stdout preamble: both daemon channels retain their existing byte protocol. */
export const WSL_DAEMON_CONNECTOR_SCRIPT = String.raw`
const net = require('node:net');
const plan = JSON.parse(process.argv[1]);
if (String(process.getuid()) !== plan.userId || process.env.HOME !== plan.home) {
  throw new Error('WSL daemon execution owner changed');
}
const socket = net.createConnection(plan.socket);
socket.once('connect', () => {
  process.stderr.write('ORCA_WSL_DAEMON_CONNECTED\n');
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);
});
socket.once('error', () => { process.exitCode = 1; });
socket.once('close', () => { process.stdin.destroy(); });
process.stdin.once('error', () => socket.destroy());
process.stdout.once('error', () => socket.destroy());
`

export const WSL_DAEMON_READ_TOKEN_SCRIPT = String.raw`
const fs = require('node:fs');
const plan = JSON.parse(process.argv[1]);
if (String(process.getuid()) !== plan.userId || process.env.HOME !== plan.home) {
  throw new Error('WSL daemon execution owner changed');
}
const fd = fs.openSync(plan.tokenPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
try {
  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || stat.uid !== process.getuid() || (stat.mode & 0o077) || stat.size > 4096) {
    throw new Error('WSL daemon token ownership is unverifiable');
  }
  process.stdout.write(fs.readFileSync(fd, 'utf8').trim());
} finally { fs.closeSync(fd); }
`
