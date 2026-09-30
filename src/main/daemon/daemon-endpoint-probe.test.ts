import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { probeSocketConnect, type SocketProbeOutcome } from './daemon-endpoint-probe'
import { getDaemonSocketPath } from './daemon-spawner'

function stallMainThread(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

describe('daemon endpoint connect probe', () => {
  let dir: string
  let server: Server | null = null

  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = null
    rmSync(dir, { recursive: true, force: true })
  })

  // Why from the check phase: the next loop turn then runs the expired timer before polling I/O,
  // which is the order a stalled app main thread sees at startup.
  it('reports a connect that completed while the main thread stalled past the timer', async () => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-endpoint-probe-'))
    const socketPath = getDaemonSocketPath(dir, 35)
    const listener = createServer((connection) => connection.destroy())
    server = listener
    await new Promise<void>((resolve) => listener.listen(socketPath, resolve))

    const outcome = await new Promise<SocketProbeOutcome>((resolve) => {
      setImmediate(() => {
        const probe = probeSocketConnect(socketPath, 20)
        stallMainThread(250)
        void probe.then(resolve)
      })
    })

    expect(outcome).toBe('connected')
  })
})
