import { createServer } from 'node:http'
import { describe, expect, it } from 'vitest'
import { waitForServeSimEndpointReady } from './serve-sim-endpoint-readiness'

describe('simulator stream readiness', () => {
  it('requires a complete frame from the requested stream, not just a listener', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/frame') {
        res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame' })
        res.end(Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]))
      } else {
        res.writeHead(503)
        res.end()
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('No test port')
      }
      const url = `http://127.0.0.1:${address.port}`
      expect(await waitForServeSimEndpointReady(`${url}/missing`, 200)).toBe(false)
      expect(await waitForServeSimEndpointReady(`${url}/frame`, 1000)).toBe(true)
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })
})
