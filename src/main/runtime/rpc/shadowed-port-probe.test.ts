import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPortNotShadowingListener } from './shadowed-port-probe'
import { WebSocketTransport } from './ws-transport'

const servers: Server[] = []
const transports: WebSocketTransport[] = []

async function listen(host: string, port = 0): Promise<number> {
  const server = createServer((socket) => socket.destroy())
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(port, host, resolve))
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('no port')
  }
  return address.port
}

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  if (!address || typeof address === 'string') {
    throw new Error('no port')
  }
  return address.port
}

afterEach(async () => {
  await Promise.all(transports.splice(0).map((transport) => transport.stop()))
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('assertPortNotShadowingListener', () => {
  it('reports a port another process answers on as in use', async () => {
    const port = await listen('0.0.0.0')

    await expect(assertPortNotShadowingListener('127.0.0.1', port)).rejects.toMatchObject({
      code: 'EADDRINUSE',
      port
    })
  })

  it('lets a free port through', async () => {
    await expect(assertPortNotShadowingListener('127.0.0.1', await freePort())).resolves.toBe(
      undefined
    )
  })

  it('leaves wildcard binds and OS-assigned ports to the kernel', async () => {
    const port = await listen('0.0.0.0')

    await expect(assertPortNotShadowingListener('0.0.0.0', port)).resolves.toBe(undefined)
    await expect(assertPortNotShadowingListener('127.0.0.1', 0)).resolves.toBe(undefined)
  })
})

describe('WebSocketTransport beside a wildcard listener', () => {
  it('moves past a port another runtime serves on every interface instead of shadowing it', async () => {
    // The defect this pins: Windows (and macOS) let 127.0.0.1:P bind over another process's
    // 0.0.0.0:P, so a managed orcad silently took loopback traffic meant for the desktop runtime.
    const heldPort = await listen('0.0.0.0')
    const nextPort = await freePort()
    const transport = new WebSocketTransport({
      host: '127.0.0.1',
      port: heldPort,
      fallbackLadder: [nextPort]
    })
    transports.push(transport)

    await transport.start()

    expect(transport.resolvedPort).toBe(nextPort)
  })
})
