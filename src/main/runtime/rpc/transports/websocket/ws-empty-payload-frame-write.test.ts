import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

/** Guard config/patches/ws@8.22.0.patch: empty writes can EFAULT under Electron on arm64 39-bit VA kernels, closing ping/pong connections with 1006. */

type Peer = { ws: WebSocket; writeLengths: number[] }

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup()
  }
})

function failEmptyWritesLikeArm64Electron(socket: Socket): number[] {
  const writeLengths: number[] = []
  const write = socket.write.bind(socket)
  // ws calls write(chunk, cb); Node treats a function encoding as the callback.
  vi.spyOn(socket, 'write').mockImplementation((chunk, encoding, cb) => {
    writeLengths.push(chunk.length)
    if (chunk.length === 0) {
      socket.destroy(Object.assign(new Error('write EFAULT'), { code: 'EFAULT' }))
      return false
    }
    return write(chunk, encoding, cb)
  })
  return writeLengths
}

async function connectPair(): Promise<{ server: Peer; client: Peer }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  cleanups.push(() => wss.close())
  await new Promise<void>((resolve) => wss.once('listening', resolve))
  const address = wss.address()
  if (typeof address !== 'object' || address === null) {
    throw new Error('WebSocketServer has no TCP address')
  }
  const { port } = address

  const serverPeer = new Promise<Peer>((resolve) => {
    wss.once('connection', (ws, request) => {
      resolve({ ws, writeLengths: failEmptyWritesLikeArm64Electron(request.socket) })
    })
  })
  const clientWs = new WebSocket(`ws://127.0.0.1:${port}`)
  cleanups.push(() => clientWs.terminate())
  let clientWriteLengths: number[] = []
  clientWs.once('upgrade', (response) => {
    clientWriteLengths = failEmptyWritesLikeArm64Electron(response.socket)
  })
  await new Promise<void>((resolve, reject) => {
    clientWs.once('open', () => resolve())
    clientWs.once('error', reject)
  })
  const server = await serverPeer
  return { server, client: { ws: clientWs, writeLengths: clientWriteLengths } }
}

function sendCallback(): {
  done: Promise<Error | null | undefined>
  cb: (err?: Error | null) => void
} {
  let cb: (err?: Error | null) => void = () => {}
  const done = new Promise<Error | null | undefined>((resolve) => {
    cb = vi.fn((err?: Error | null) => resolve(err))
  })
  return { done, cb }
}

describe('ws empty-payload frame writes', () => {
  it('server heartbeat ping with no payload reaches the client and keeps the socket open', async () => {
    const { server, client } = await connectPair()
    const received = new Promise<Buffer>((resolve) => client.ws.once('ping', resolve))
    const { done, cb } = sendCallback()

    server.ws.ping(undefined, undefined, cb)

    expect(await done).toBeFalsy()
    expect((await received).length).toBe(0)
    // ws auto-pongs the client's empty ping back on the server's socket.
    await new Promise<void>((resolve) => server.ws.once('pong', () => resolve()))
    expect(server.writeLengths).not.toContain(0)
    expect(client.writeLengths).not.toContain(0)
    expect(server.ws.readyState).toBe(WebSocket.OPEN)
    expect(cb).toHaveBeenCalledTimes(1)
  })
})
