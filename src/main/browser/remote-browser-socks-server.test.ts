import { once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteBrowserSocksServer } from './remote-browser-socks-server'

const servers: RemoteBrowserSocksServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()))
})

async function connectClient(
  server: RemoteBrowserSocksServer,
  allowHalfOpen = false
): Promise<Socket> {
  const address = await server.listen()
  const socket = connect({ port: address.port, host: address.host, allowHalfOpen })
  await once(socket, 'connect')
  return socket
}

async function readExact(socket: Socket, size: number): Promise<Uint8Array> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < size) {
    const [chunk] = (await once(socket, 'data')) as [Buffer]
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const combined = Buffer.concat(chunks)
  if (combined.byteLength > size) {
    socket.unshift(combined.subarray(size))
  }
  return combined.subarray(0, size)
}

async function greet(socket: Socket): Promise<void> {
  socket.write(new Uint8Array([5, 1, 0]))
  expect(Array.from(await readExact(socket, 2))).toEqual([5, 0])
}

function domainConnectRequest(host: string, port: number, command = 1): Uint8Array {
  const name = new TextEncoder().encode(host)
  const request = new Uint8Array(7 + name.byteLength)
  const view = new DataView(request.buffer)
  request.set([5, command, 0, 3, name.byteLength], 0)
  request.set(name, 5)
  view.setUint16(5 + name.byteLength, port, false)
  return request
}

describe('RemoteBrowserSocksServer', () => {
  it('passes domain names unchanged to the execution-host route', async () => {
    const upstream = new PassThrough()
    const settleRead = vi.fn()
    Object.assign(upstream, { settleRead })
    const open = vi.fn(async () => upstream)
    const server = new RemoteBrowserSocksServer({ open })
    servers.push(server)
    const socket = await connectClient(server)
    await greet(socket)

    socket.write(domainConnectRequest('split-horizon.internal.', 8443))

    expect(Array.from(await readExact(socket, 10))).toEqual([5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(open).toHaveBeenCalledWith({ host: 'split-horizon.internal.', port: 8443 })

    socket.write('remote bytes')
    expect(new TextDecoder().decode(await readExact(socket, 12))).toBe('remote bytes')
    await vi.waitFor(() => expect(settleRead).toHaveBeenCalledWith(12))
    socket.destroy()
  })

  it('normalizes listener wildcards only at the final route boundary', async () => {
    const open = vi.fn(async () => new PassThrough())
    const server = new RemoteBrowserSocksServer({ open })
    servers.push(server)
    const socket = await connectClient(server)
    await greet(socket)

    socket.write(domainConnectRequest('0.0.0.0', 3000))
    await readExact(socket, 10)

    expect(open).toHaveBeenCalledWith({ host: '127.0.0.1', port: 3000 })
    socket.destroy()
  })

  it('rejects unsupported commands without opening a destination', async () => {
    const open = vi.fn(async () => new PassThrough())
    const server = new RemoteBrowserSocksServer({ open })
    servers.push(server)
    const socket = await connectClient(server)
    await greet(socket)

    socket.write(domainConnectRequest('localhost', 80, 2))

    expect(Array.from(await readExact(socket, 10))).toEqual([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(open).not.toHaveBeenCalled()
  })

  it('fails closed when the execution-host route is unavailable', async () => {
    const open = vi.fn(async () => {
      throw new Error('route offline')
    })
    const server = new RemoteBrowserSocksServer({ open })
    servers.push(server)
    const socket = await connectClient(server)
    await greet(socket)

    socket.write(domainConnectRequest('localhost', 3000))

    expect(Array.from(await readExact(socket, 10))).toEqual([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('contains synchronous route failures and large pipelined requests', async () => {
    const failingServer = new RemoteBrowserSocksServer({
      open: () => {
        throw new Error('route failed synchronously')
      }
    })
    servers.push(failingServer)
    const failingSocket = await connectClient(failingServer)
    await greet(failingSocket)
    failingSocket.write(domainConnectRequest('localhost', 3000))
    expect(Array.from(await readExact(failingSocket, 10))).toEqual([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])

    let resolveOpen: ((stream: PassThrough) => void) | undefined
    const open = vi.fn(
      () =>
        new Promise<PassThrough>((resolve) => {
          resolveOpen = resolve
        })
    )
    const server = new RemoteBrowserSocksServer({ open })
    servers.push(server)
    const socket = await connectClient(server)
    await greet(socket)
    const payload = Buffer.alloc(4 * 1024, 7)
    socket.write(Buffer.concat([domainConnectRequest('localhost', 443), payload]))
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))
    resolveOpen?.(new PassThrough())
    await readExact(socket, 10)
    expect(await readExact(socket, payload.byteLength)).toEqual(payload)
    socket.destroy()
  })

  it('closes deterministically during bind and with a failed half-open peer', async () => {
    const server = new RemoteBrowserSocksServer({
      open: async () => new PassThrough()
    })
    servers.push(server)
    const listening = server.listen()
    const closing = server.close()
    const address = await listening
    await closing
    const postCloseSocket = connect(address.port, address.host)
    await expect(once(postCloseSocket, 'connect')).rejects.toBeTruthy()
    await expect(server.listen()).rejects.toThrow('closed')

    const peerServer = new RemoteBrowserSocksServer({
      open: async () => new PassThrough()
    })
    servers.push(peerServer)
    const peer = await connectClient(peerServer, true)
    try {
      await greet(peer)
      const peerEnded = once(peer, 'end').then(
        () => true,
        () => false
      )
      peer.write(domainConnectRequest('localhost', 80, 2))
      expect(Array.from(await readExact(peer, 10))).toEqual([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])
      expect(await peerEnded).toBe(true)
      expect(peer.writable).toBe(true)
      await expect(
        Promise.race([
          peerServer.close().then(() => 'closed'),
          new Promise<string>((resolve) => setTimeout(() => resolve('timed-out'), 1_000))
        ])
      ).resolves.toBe('closed')
    } finally {
      peer.destroy()
    }
  })

  it.each([0, 4 * 1024 * 1024])(
    'cannot resolve a rejected pending route with %i additional client bytes',
    async (additionalBytes) => {
      let resolveOpen: ((stream: PassThrough) => void) | undefined
      const open = vi.fn(
        () =>
          new Promise<PassThrough>((resolve) => {
            resolveOpen = resolve
          })
      )
      const server = new RemoteBrowserSocksServer({ open })
      servers.push(server)
      const socket = await connectClient(server, additionalBytes > 0)
      const errors: NodeJS.ErrnoException[] = []
      const onError = (error: NodeJS.ErrnoException): void => {
        errors.push(error)
      }
      socket.on('error', onError)
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()))
      try {
        await greet(socket)
        socket.write(domainConnectRequest('localhost', 443))
        await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1))

        socket.write(Buffer.alloc(300 * 1024, 7))
        expect(Array.from(await readExact(socket, 10))).toEqual([5, 1, 0, 1, 0, 0, 0, 0, 0, 0])
        if (additionalBytes > 0) {
          expect(socket.writable).toBe(true)
          socket.write(Buffer.alloc(additionalBytes, 7))
        }
        const upstream = new PassThrough()
        resolveOpen?.(upstream)
        await vi.waitFor(() => expect(upstream.destroyed).toBe(true))
        expect(upstream.readableLength).toBe(0)
        await closed
        expect(socket.destroyed).toBe(true)
        for (const error of errors) {
          expect(['ECONNRESET', 'EPIPE']).toContain(error.code)
        }
      } finally {
        socket.destroy()
        await closed
        socket.off('error', onError)
      }
    }
  )
})
