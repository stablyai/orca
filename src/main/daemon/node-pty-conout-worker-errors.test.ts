import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, Socket, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

type ConoutConnection = {
  onReady(listener: () => void): void
  onFailed(listener: () => void): void
  connectSocket(socket: Socket): void
  dispose(): void
}
type ConoutConnectionConstructor = new (pipeName: string, useConptyDll: boolean) => ConoutConnection

const requireFromTest = createRequire(import.meta.url)
const conoutModule: unknown = requireFromTest('node-pty/lib/windowsConoutConnection')
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-pty's Windows output relay is untyped JS exporting this constructor.
const { ConoutConnection: ConoutConnectionImpl } = conoutModule as {
  ConoutConnection: ConoutConnectionConstructor
}

const DRAIN_TIMEOUT_MS = 5_000

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    cleanup()
  }
})

function conoutPipeName(): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\orca-conout-test-${process.pid}-${Date.now()}`
  }
  const dir = mkdtempSync(join(tmpdir(), 'orca-conout-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, 'conout.sock')
}

function trackUncaught(): unknown[] {
  const uncaught: unknown[] = []
  const listener = (error: unknown): void => {
    uncaught.push(error)
  }
  process.on('uncaughtException', listener)
  cleanups.push(() => process.off('uncaughtException', listener))
  return uncaught
}

// Stands in for ConPTY: the worker connects to it, and its writes block once nobody drains them.
async function startFakeConout(
  pipeName: string
): Promise<{ server: Server; peer: Promise<Socket> }> {
  let acceptPeer: (socket: Socket) => void = () => {}
  const peer = new Promise<Socket>((resolve) => {
    acceptPeer = resolve
  })
  const server = createServer((socket) => {
    socket.on('error', () => {})
    cleanups.push(() => socket.destroy())
    acceptPeer(socket)
  })
  server.listen(pipeName)
  await once(server, 'listening')
  cleanups.push(() => server.close())
  return { server, peer }
}

describe('node-pty ConPTY output relay worker', () => {
  it('survives a write error after its reader closes and keeps draining ConPTY output', async () => {
    const uncaught = trackUncaught()
    const pipeName = conoutPipeName()
    const { peer: peerPromise } = await startFakeConout(pipeName)

    const connection = new ConoutConnectionImpl(pipeName, true)
    cleanups.push(() => connection.dispose())
    const reader = new Socket()
    reader.on('error', () => {})
    connection.onReady(() => connection.connectSocket(reader))
    const peer = await peerPromise
    await once(reader, 'connect')

    // A paused reader (producer backpressure) lets the worker queue writes that fail once it closes.
    reader.pause()
    const chunk = Buffer.alloc(64 * 1024, 0x78)
    for (let i = 0; i < 64; i++) {
      peer.write(chunk)
    }
    while (reader.readableLength === 0) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    reader.destroy()

    // ConPTY's final flush must still be consumed, or ClosePseudoConsole can block on a full pipe.
    // The callback also runs on failure: a crashed worker surfaces here as EPIPE, not as drained.
    const drained = new Promise<string>((resolve) =>
      peer.write(chunk, (error) => resolve(error ? `write failed: ${error.message}` : 'drained'))
    )
    let drainTimer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<string>((resolve) => {
      drainTimer = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
    })
    const outcome = await Promise.race([drained, timedOut])
    clearTimeout(drainTimer)

    expect(uncaught).toEqual([])
    expect(outcome).toBe('drained')
  }, 15_000)

  it('reports a relay that cannot reach ConPTY instead of crashing or hanging its terminal', async () => {
    const uncaught = trackUncaught()
    const connection = new ConoutConnectionImpl(conoutPipeName(), true)
    let ready = false
    connection.onReady(() => {
      ready = true
    })
    await new Promise<void>((resolve) => connection.onFailed(resolve))

    expect(ready).toBe(false)
    expect(uncaught).toEqual([])
  }, 15_000)
})
