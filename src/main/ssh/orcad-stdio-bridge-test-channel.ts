/** Test-only: a bridge run as a local child, shaped like the SSH exec channel that runs it. */
import { createServer, type Server } from 'node:net'
import { Duplex } from 'node:stream'
import type { ClientChannel } from 'ssh2'
import { spawnProcess } from '../../shared/child-process/run-process'

export function spawnLocalBridgeChannel(
  program: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env
): ClientChannel {
  const child = spawnProcess({ program, args, env })
  // Why emitClose off: like ssh2, `close` comes once, after the exit status.
  const channel = new Duplex({
    emitClose: false,
    read() {
      child.stdout.resume()
    },
    write(chunk: Buffer, _encoding, done) {
      child.stdin.write(chunk, done)
    },
    final(done) {
      child.stdin.end(done)
    }
  })
  child.stdout.on('data', (chunk: Buffer) => {
    if (!channel.push(chunk)) {
      child.stdout.pause()
    }
  })
  child.stdout.on('end', () => channel.push(null))
  child.stdin.on('error', () => {})
  child.on('exit', (code) => channel.emit('exit', code))
  child.on('close', () => channel.emit('close'))
  Object.assign(channel, { stderr: child.stderr, close: () => child.kill() })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bridge paths use only the stream, `stderr`, `close`, and the `exit`/`close` events assigned above.
  return channel as unknown as ClientChannel
}

/** A loopback echo server standing in for orcad. */
export async function startEchoServer(): Promise<{ server: Server; port: number }> {
  const server = createServer((socket) => {
    socket.on('error', () => socket.destroy())
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('echo server has no port')
  }
  return { server, port: address.port }
}
