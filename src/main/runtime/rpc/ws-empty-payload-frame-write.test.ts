import type { Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'

/**
 * Guards config/patches/ws@8.22.0.patch. Under Electron on arm64 kernels with
 * 39-bit virtual addresses, `socket.write()` of a zero-length buffer fails with
 * EFAULT and destroys the socket, so every empty ping, auto-pong or empty frame
 * closed the remote runtime connection with 1006. These sockets fail the same
 * way, so the cases fail if the patch is dropped or a ws bump loses it.
 */

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

function closedCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)))
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

  it('auto-pong to an empty client ping does not write an empty payload on the server', async () => {
    const { server, client } = await connectPair()
    const pong = new Promise<Buffer>((resolve) => client.ws.once('pong', resolve))

    client.ws.ping()

    expect((await pong).length).toBe(0)
    expect(server.writeLengths).not.toContain(0)
    expect(client.writeLengths).not.toContain(0)
    expect(server.ws.readyState).toBe(WebSocket.OPEN)
  })

  it('empty pong and empty text frames are delivered with exactly one callback each', async () => {
    const { server, client } = await connectPair()
    const pong = new Promise<Buffer>((resolve) => client.ws.once('pong', resolve))
    const message = new Promise<string>((resolve) =>
      client.ws.once('message', (data: Buffer) => resolve(data.toString()))
    )
    const pongCallback = sendCallback()
    const sendCallbackState = sendCallback()

    server.ws.pong(undefined, undefined, pongCallback.cb)
    server.ws.send('', sendCallbackState.cb)

    expect(await pongCallback.done).toBeFalsy()
    expect(await sendCallbackState.done).toBeFalsy()
    expect((await pong).length).toBe(0)
    expect(await message).toBe('')
    expect(pongCallback.cb).toHaveBeenCalledTimes(1)
    expect(sendCallbackState.cb).toHaveBeenCalledTimes(1)
    expect(server.writeLengths).not.toContain(0)
  })

  it('a close with no code completes the closing handshake instead of 1006', async () => {
    const { server, client } = await connectPair()
    const clientClosed = closedCode(client.ws)

    server.ws.close()

    expect(await clientClosed).toBe(1005)
    expect(server.writeLengths).not.toContain(0)
    expect(client.writeLengths).not.toContain(0)
  })
})
