import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { MjpegFrameStream } from './mjpeg-frame-stream'

const JPEG = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])

let server: Server | null = null

afterEach(async () => {
  if (!server) {
    return
  }
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  server = null
})

function listen(serverToStart: Server): Promise<number> {
  return new Promise((resolve) => {
    serverToStart.listen(0, '127.0.0.1', () => {
      const address = serverToStart.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected TCP server address')
      }
      resolve(address.port)
    })
  })
}

describe('MjpegFrameStream', () => {
  it('reads raw MJPEG frames through Node HTTP', async () => {
    let requestUrl = ''
    const framePromise = new Promise<Buffer>((resolve, reject) => {
      const httpServer = createServer((req, res) => {
        requestUrl = req.url ?? ''
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.write(Buffer.concat([Buffer.from('--frame\r\n'), JPEG]))
        res.end()
      })
      server = httpServer

      void listen(httpServer).then((port) => {
        const stream = new MjpegFrameStream(
          `http://127.0.0.1:${port}/stream.mjpeg`,
          {
            onError: reject,
            onFrame: (frame) => {
              stream.stop()
              resolve(frame)
            }
          },
          'test-key'
        )
        stream.start()
      })
    })

    await expect(framePromise).resolves.toEqual(JPEG)
    expect(requestUrl).toBe('/stream.mjpeg?raw=1&_orca=test-key')
  })
})
