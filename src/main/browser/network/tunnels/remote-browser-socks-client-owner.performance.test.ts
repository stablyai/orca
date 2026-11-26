import { connect, createServer, type Server, type Socket } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { isOwnDarwinConnection } from './darwin-socket-owner-helper'
import { useVouchingSocketOwnerHelper } from './darwin-socket-owner-helper.test-fixture'
import {
  createSocksClientAdmission,
  holdSocksClientOwnerLookup
} from './remote-browser-socks-client-owner'

// STA-18499: on macOS a client that left while its owner lookup waited still got a full scan ahead
// of live connections. Paired forwards accept paused, half-open sockets, which don't see the client
// leave unless they read.
describe.skipIf(process.platform === 'win32')('macOS owner lookups for departed clients', () => {
  const realPlatform = process.platform
  let helper: Awaited<ReturnType<typeof useVouchingSocketOwnerHelper>>
  const servers: Server[] = []
  beforeAll(async () => {
    helper = await useVouchingSocketOwnerHelper(3_000)
  })
  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform })
    await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))))
  })
  afterAll(() => helper.restore())

  async function forwardListener(): Promise<{ port: number; admitted: Socket[] }> {
    const admission = createSocksClientAdmission('port forward')
    const admitted: Socket[] = []
    const server = createServer({ pauseOnConnect: true, allowHalfOpen: true }, (socket) => {
      socket.on('error', () => socket.destroy())
      admission(socket, () => admitted.push(socket))
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    return { port: typeof address === 'object' && address ? address.port : 0, admitted }
  }

  function connectClient(port: number): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const client = connect(port, '127.0.0.1', () => resolve(client))
      client.once('error', reject)
    })
  }

  it.each([100, 1_000])(
    'scans none of %i clients that leave while queued, and checks the live one next',
    async (n) => {
      Object.defineProperty(process, 'platform', { value: 'darwin' })
      const release = holdSocksClientOwnerLookup()
      const { port, admitted } = await forwardListener()
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
        // Half close politely, half reset: neither is a connection anyone will answer.
        batch.forEach((client, offset) =>
          offset % 2 === 0 ? client.end() : client.resetAndDestroy()
        )
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      const live = await connectClient(port)
      await inFlight
      await expect.poll(() => admitted.length, { timeout: 5_000 }).toBe(1)
      const scans = (await helper.scans()).slice(before)
      expect(scans).toHaveLength(2)
      expect(scans[1]).toBe(`127.0.0.1 ${live.localPort} 127.0.0.1 ${port}`)
      live.destroy()
      for (const socket of admitted) {
        socket.destroy()
      }
      release()
    },
    30_000
  )
})
