import { once } from 'node:events'
import { createServer } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { postJsonForJson } from './diagnostic-upload-http'

describe('diagnostic HTTP socket teardown', () => {
  it('handles late request errors and closes sockets after repeated header timeouts', async () => {
    const server = createServer((request) => request.resume())
    let connections = 0
    let closed = 0
    server.on('connection', (socket) => {
      connections++
      socket.once('close', () => closed++)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a loopback TCP server')
    }
    try {
      for (let cycle = 0; cycle < 5; cycle++) {
        await expect(
          postJsonForJson(`http://127.0.0.1:${address.port}/upload`, {}, 50)
        ).rejects.toThrow('diagnostic network request timed out')
      }
      await vi.waitFor(() => expect(closed).toBe(5))
      expect(connections).toBe(5)
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
