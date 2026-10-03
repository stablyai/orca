import { connect, createServer, type Server, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { PortForwardListener } from './port-forward-listener'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.()
  }
})

function closeLater(server: Server): void {
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
}

function portOf(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

/** Stands in for the host side: an echo origin, and an opener returning a real socket to
 *  it. A net.Socket is already a Duplex, which is exactly what the tunnel hands back. */
async function echoOrigin(transform: (input: string) => string = (v) => v) {
  const origin = createServer((socket) => {
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk) => socket.write(transform(chunk.toString())))
  })
  closeLater(origin)
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', () => resolve()))
  const originPort = portOf(origin)
  return (): Promise<Duplex> =>
    Promise.resolve(connect({ port: originPort, host: '127.0.0.1', allowHalfOpen: true }))
}

async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const port = portOf(probe)
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

async function occupy(port: number): Promise<void> {
  const server = createServer()
  closeLater(server)
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
}

/** Resolves with the first reply, or rejects when the connection dies without one. */
function request(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let answered = false
    const socket: Socket = connect({ port, host: '127.0.0.1' }, () => socket.write(payload))
    socket.on('data', (chunk) => {
      answered = true
      resolve(chunk.toString())
      socket.destroy()
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (!answered) {
        reject(new Error('closed without a reply'))
      }
    })
  })
}

describe('PortForwardListener', () => {
  it('carries bytes between a local connection and the remote stream', async () => {
    const listener = new PortForwardListener(await echoOrigin((v) => `echo:${v}`))
    cleanups.push(() => listener.close())

    const binding = await listener.listen(await freePort())

    expect(binding.exact).toBe(true)
    await expect(request(binding.port, 'hello')).resolves.toBe('echo:hello')
  })

  it('keeps the preferred port when it is free, so the URL stays byte-identical', async () => {
    const wanted = await freePort()
    const listener = new PortForwardListener(await echoOrigin())
    cleanups.push(() => listener.close())

    await expect(listener.listen(wanted)).resolves.toEqual({ port: wanted, exact: true })
  })

  it('falls back to another port and reports it, rather than failing outright', async () => {
    const wanted = await freePort()
    await occupy(wanted)
    const listener = new PortForwardListener(await echoOrigin())
    cleanups.push(() => listener.close())

    const binding = await listener.listen(wanted)

    // exact:false is the signal callers must surface — a remapped port breaks anything
    // carrying the original number (hot-reload sockets, OAuth redirects, absolute URLs).
    expect(binding.exact).toBe(false)
    expect(binding.port).not.toBe(wanted)
    await expect(request(binding.port, 'ping')).resolves.toBe('ping')
  })

  it('serves more than one connection over the same binding', async () => {
    const listener = new PortForwardListener(await echoOrigin((v) => `<${v}>`))
    cleanups.push(() => listener.close())
    const binding = await listener.listen(await freePort())

    await expect(
      Promise.all([request(binding.port, 'a'), request(binding.port, 'b')])
    ).resolves.toEqual(['<a>', '<b>'])
  })

  it('drops the connection when the stream cannot be opened instead of hanging it', async () => {
    const listener = new PortForwardListener(() => Promise.reject(new Error('tunnel is down')))
    cleanups.push(() => listener.close())
    const binding = await listener.listen(await freePort())

    await expect(request(binding.port, 'hello')).rejects.toThrow()
  })

  it('refuses new connections once closed', async () => {
    const listener = new PortForwardListener(await echoOrigin())
    const binding = await listener.listen(await freePort())
    await listener.close()

    await expect(request(binding.port, 'hello')).rejects.toThrow()
  })
})
