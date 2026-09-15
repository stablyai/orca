import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { allocateLoopbackPort, waitForWatchPort } from './office-watch-port'

const servers: Server[] = []

function listenOnLoopback(port: number): Promise<void> {
  return new Promise((done, reject) => {
    const server = createServer()
    servers.push(server)
    server.once('error', reject)
    server.listen({ host: '127.0.0.1', port }, () => done())
  })
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done())))
  )
})

describe('watch port allocation and readiness', () => {
  it('allocates a free loopback port and releases it', async () => {
    const port = await allocateLoopbackPort()
    expect(port).toBeGreaterThan(0)
    // Releasing is the whole point: the watch process has to be able to bind it next.
    await expect(listenOnLoopback(port)).resolves.toBeUndefined()
  })

  it('reports ready once something accepts on the port', async () => {
    const port = await allocateLoopbackPort()
    await listenOnLoopback(port)
    await expect(
      waitForWatchPort(port, { intervalMs: 5, timeoutMs: 2_000 }, async () => {})
    ).resolves.toBe('ready')
  })

  it('gives up at the ceiling when nothing ever listens', async () => {
    const port = await allocateLoopbackPort()
    await expect(
      waitForWatchPort(port, { intervalMs: 1, timeoutMs: 30 }, async () => {})
    ).resolves.toBe('timeout')
  })

  it('ends immediately when the child is gone, rather than waiting out the ceiling', async () => {
    // A 15 s wait for a process that died in the first 200 ms tells the reader nothing and
    // delays the fallback to a snapshot.
    const port = await allocateLoopbackPort()
    await expect(
      waitForWatchPort(
        port,
        { intervalMs: 1, timeoutMs: 60_000, isAlive: () => false },
        async () => {}
      )
    ).resolves.toBe('exited')
  })
})
