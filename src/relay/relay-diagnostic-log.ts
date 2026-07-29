// Why: the relay daemon's stderr is redirected to relay.log on the remote
// host. Without timestamps, reconnect flaps in that log cannot be correlated
// with user activity or sleep/wake windows during diagnosis (#7773). Keep the
// format grep-stable: ISO timestamp, single space, then the original line.
export function relayLogLine(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`)
}
