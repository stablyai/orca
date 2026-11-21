import { connect, createServer, Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { installBestEffortSocketTypeOfService } from './best-effort-socket-type-of-service'

const nativeSetTypeOfService = Socket.prototype.setTypeOfService
let server: Server | null = null
let client: Socket | null = null

afterEach(() => {
  Socket.prototype.setTypeOfService = nativeSetTypeOfService
  client?.destroy()
  client = null
  server?.close()
  server = null
})

// Paused so the client never reads the RST and keeps the reset handle open, like undici's pooled socket.
async function connectToResettingServer(): Promise<Socket> {
  const resetServer = createServer((accepted) => accepted.resetAndDestroy())
  server = resetServer
  await new Promise<void>((resolve) => resetServer.listen(0, '127.0.0.1', resolve))
  const address = resetServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const peerReset = new Promise<void>((resolve) =>
    resetServer.once('connection', (accepted) => accepted.once('close', () => resolve()))
  )
  const resetClient = connect({ port, host: '127.0.0.1' })
  client = resetClient
  resetClient.pause()
  resetClient.on('error', () => {})
  await peerReset
  return resetClient
}

describe('installBestEffortSocketTypeOfService', () => {
  it.runIf(process.platform === 'darwin')(
    'reproduces the native EINVAL on a reset macOS socket',
    async () => {
      const resetClient = await connectToResettingServer()

      expect(() => resetClient.setTypeOfService(0)).toThrow(
        expect.objectContaining({ code: 'EINVAL', syscall: 'setTypeOfService' })
      )
    }
  )

  it('ignores the TOS syscall failure on a socket the peer reset (#39579)', async () => {
    const resetClient = await connectToResettingServer()
    installBestEffortSocketTypeOfService()

    expect(resetClient.setTypeOfService(0)).toBe(resetClient)
    expect(() => resetClient.setTypeOfService(256)).toThrow(RangeError)
  })
})
