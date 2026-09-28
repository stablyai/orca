import { createServer, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runBundledBunFixture } from '../../../bundled-bun-test-execution'
import type { BunPtySpawnArgs } from '../bun-pty-process-contract'

/** Keeps live observers in Vitest while their POSIX PTY runs under pinned Bun. */
export async function startBundledBunPty(args: BunPtySpawnArgs) {
  const socketPath = join(args.cwd, 'terminal.sock')
  const server = createServer()
  const connected = new Promise<Socket>((resolve) => server.once('connection', resolve))
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, resolve)
  })
  const fixture = runBundledBunFixture(
    join(__dirname, 'bundled-bun-pty-host-fixture.ts'),
    'runBundledBunPty',
    { socketPath, args },
    35_000
  )
  try {
    const socket = await Promise.race([
      connected,
      fixture.then(() => {
        throw new Error('Bun PTY fixture exited before connecting')
      })
    ])
    const pid = Number(readFileSync(`${socketPath}.pid`, 'utf8'))
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      socket.destroy()
      throw new Error('Invalid Bun PTY fixture process ID')
    }
    socket.setEncoding('utf8')
    // Retain asynchronous fixture failures for dispose(), without an unhandled rejection.
    void fixture.catch(() => {})
    return {
      pid,
      kill: () => {
        socket.destroy()
      },
      write: (data: string) => {
        socket.write(data)
      },
      onData: (listener: (data: string) => void) => {
        socket.on('data', listener)
      },
      onExit: (listener: () => void) => {
        socket.on('end', listener)
      },
      dispose: async () => {
        socket.destroy()
        await fixture
      }
    }
  } finally {
    server.close()
  }
}
