import { createConnection } from 'node:net'
import { writeFileSync } from 'node:fs'
import { spawnBunPty } from '../bun-pty-process'
import type { BunPtySpawnArgs } from '../bun-pty-process-contract'

export async function runBundledBunPty({
  socketPath,
  args
}: {
  socketPath: string
  args: BunPtySpawnArgs
}): Promise<number> {
  const term = spawnBunPty(args)
  writeFileSync(`${socketPath}.pid`, String(term.pid), { mode: 0o600 })
  const socket = createConnection(socketPath)
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', (error) => {
      term.destroy()
      reject(error)
    })
  })
  socket.setEncoding('utf8')
  const exited = new Promise<number>((resolve) => term.onExit(({ exitCode }) => resolve(exitCode)))
  socket.on('data', (data: string) => term.write(data))
  socket.on('close', () => term.kill())
  socket.on('error', () => term.kill())
  term.onData((data) => {
    if (!socket.destroyed) {
      socket.write(data)
    }
  })
  try {
    return await exited
  } finally {
    term.destroy()
    socket.end()
  }
}
