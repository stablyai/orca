import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isOwnDarwinConnection } from './darwin-socket-owner-helper'
import { useVouchingSocketOwnerHelper } from './darwin-socket-owner-helper.test-fixture'
import {
  createSocksClientAdmission,
  holdSocksClientOwnerLookup
} from './remote-browser-socks-client-owner'

// STA-18499: on macOS a client that left while its owner lookup waited still got a full scan ahead
// of live connections. Paired forwards accept paused sockets, which don't see a reset unless they read.
describe.skipIf(process.platform === 'win32')('macOS owner lookups for departed clients', () => {
  const realPlatform = process.platform
  let helper: Awaited<ReturnType<typeof useVouchingSocketOwnerHelper>>
  const servers: Server[] = []
  const sockets: Socket[] = []
  let releaseLookup = (): void => {}
  beforeAll(async () => {
    helper = await useVouchingSocketOwnerHelper(true)
  })
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    // Stops the helper, held answer and all.
    releaseLookup()
    for (const socket of sockets.splice(0)) {
      socket.destroy()
    }
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  })
  afterAll(() => helper.restore())

  async function forwardListener(): Promise<{
    port: number
    accepted: Socket[]
    admitted: Socket[]
  }> {
    const admission = createSocksClientAdmission('port forward')
    const accepted: Socket[] = []
    const admitted: Socket[] = []
    const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
      accepted.push(socket)
      sockets.push(socket)
      socket.on('error', () => socket.destroy())
      admission(socket, () => admitted.push(socket))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return { port: typeof address === 'object' && address ? address.port : 0, accepted, admitted }
  }

  function connectClient(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const client = connect(port, '127.0.0.1', () => resolve(client))
      sockets.push(client)
      client.once('error', reject)
    })
  }

  it.each([100, 1_000])(
    'scans none of %i clients that reset while queued, and checks the live ones next',
    async (n) => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      releaseLookup = holdSocksClientOwnerLookup()
      const { port, accepted, admitted } = await forwardListener()
      const before = (await helper.scans()).length
      const inFlight = isOwnDarwinConnection(
        { host: '127.0.0.1', port: 1 },
        { host: '127.0.0.1', port }
      )
      // In batches, so the test stays under the open-file limit while the first lookup is held.
      for (let index = 0; index < n; index += 50) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(50, n - index) }, () => connectClient(port))
        )
        await expect.poll(() => accepted.length).toBe(index + batch.length)
        for (const client of batch) {
          client.resetAndDestroy()
        }
      }
      // Each departed connection is dropped, and its server side destroyed, while the first lookup is held.
      await expect
        .poll(() => accepted.filter((socket) => socket.destroyed).length, { timeout: 2_500 })
        .toBe(n)
      // A half-close is still a live connection: the client may be waiting for the server to speak.
      const halfClosed = await connectClient(port)
      halfClosed.end()
      const live = await connectClient(port)
      await helper.releaseFirstAnswer()
      await inFlight
      await expect.poll(() => admitted.length, { timeout: 5_000 }).toBe(2)
      expect((await helper.scans()).slice(before).slice(1)).toEqual([
        `127.0.0.1 ${halfClosed.localPort} 127.0.0.1 ${port}`,
        `127.0.0.1 ${live.localPort} 127.0.0.1 ${port}`
      ])
    },
    30_000
  )
})
