import { createHash } from 'node:crypto'
import { join } from 'node:path'

export function relayTestSocketPath(dir: string, name = 'relay.sock'): string {
  if (process.platform !== 'win32') {
    return join(dir, name)
  }

  const suffix = createHash('sha256')
    .update(`${process.pid}\0${dir}\0${name}`)
    .digest('hex')
    .slice(0, 20)

  // Why: Node's net server requires Windows IPC endpoints to be named pipes;
  // filesystem-style .sock paths fail with EACCES on Windows hosts.
  return `\\\\.\\pipe\\orca-relay-test-${suffix}`
}
