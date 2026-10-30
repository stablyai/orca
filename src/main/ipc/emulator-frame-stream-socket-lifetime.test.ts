import { EventEmitter, once } from 'node:events'
import { createServer, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'

const handlers = new Map<string, (event: unknown, args: unknown) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, args: unknown) => unknown) => {
      handlers.set(channel, handler)
    }
  },
  BrowserWindow: { fromWebContents: () => ({}) }
}))

import { registerEmulatorFrameStreamHandlers } from './emulator-frame-stream'

class Owner extends EventEmitter {
  isDestroyed = (): boolean => false
  send = (): void => {
    this.emit('frame-received')
  }
}

let server: Server | null = null
let owner: Owner | null = null

afterEach(async () => {
  owner?.emit('destroyed')
  owner = null
  if (server) {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server?.close(() => resolve()))
    server = null
  }
})

it.each(['did-navigate', 'render-process-gone', 'destroyed'])(
  'closes the live MJPEG HTTP socket after %s',
  async (goneEvent) => {
    registerEmulatorFrameStreamHandlers()
    const sockets = new Set<Socket>()
    const httpServer = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/octet-stream' })
      response.write(Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]))
    })
    server = httpServer
    httpServer.on('connection', (socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected TCP address')
    }
    const sender = new Owner()
    owner = sender
    const frameReceived = once(sender, 'frame-received')
    handlers.get('emulator:frameStreamStart')?.(
      { sender },
      { streamUrl: `http://127.0.0.1:${address.port}/stream.mjpeg` }
    )
    await frameReceived
    expect(sockets.size).toBe(1)
    const closed = Promise.all(Array.from(sockets, (socket) => once(socket, 'close')))
    sender.emit(goneEvent)
    await closed
    expect(sockets.size).toBe(0)
  }
)
