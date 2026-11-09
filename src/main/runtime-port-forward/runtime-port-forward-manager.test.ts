import { createServer, connect, Socket, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserNetworkTunnelClient } from '../browser/network/tunnels/browser-network-tunnel-client'
import { BrowserNetworkTunnelSession } from '../browser/network/tunnels/browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../browser/network/tunnels/browser-network-tunnel-stream-state'
import { createPortForwardDialer } from '../runtime/rpc/methods/workspace-ports/workspace-port-forward-tunnel'
import { RuntimePortForwardManager } from './runtime-port-forward-manager'
import {
  PortForwardTunnelError,
  type PortForwardTunnelConnector
} from './runtime-port-forward-tunnel'

/** Wires a desktop tunnel client straight to a host session in-process, like the WebSocket would. */
function inProcessConnector(counter: { sessions: number }): PortForwardTunnelConnector {
  return async (_environmentId, onClosed) => {
    counter.sessions += 1
    let session: BrowserNetworkTunnelSession | null = null
    const client = new BrowserNetworkTunnelClient({
      tunnelGeneration: 1,
      sendBinary: (bytes) => {
        queueMicrotask(() => session?.handleBinary(bytes))
        return true
      },
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL,
      onClosed
    })
    session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 1,
      connect: createPortForwardDialer({}),
      sendBinary: (bytes) => {
        queueMicrotask(() => client.handleBinary(bytes))
        return true
      },
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL
    })
    return { client, close: () => client.close() }
  }
}

function listen(server: Server, port = 0, host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve(address && typeof address === 'object' ? address.port : 0)
    })
  })
}

function request(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()))
    socket.on('error', reject)
    socket.end(payload)
  })
}

const servers: Server[] = []
let manager: RuntimePortForwardManager | null = null

afterEach(() => {
  manager?.dispose()
  manager = null
  for (const server of servers.splice(0)) {
    server.close()
  }
})

async function echoServer(): Promise<number> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    const chunks: Buffer[] = []
    socket.on('data', (chunk) => chunks.push(chunk))
    socket.on('end', () => socket.end(`echo:${Buffer.concat(chunks).toString()}`))
  })
  servers.push(server)
  return listen(server)
}

describe('RuntimePortForwardManager', () => {
  it('carries connections to the host port on the same local port number when free', async () => {
    const counter = { sessions: 0 }
    manager = new RuntimePortForwardManager({ connector: inProcessConnector(counter) })
    const remotePort = await echoServer()
    // The "remote" listener is on this machine too, so the same number is taken: ask for any port.
    const result = await manager.open({
      environmentId: 'env-1',
      remotePort,
      localPort: 0,
      reason: 'user'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.forward.localPort).not.toBe(0)
    const answers = await Promise.all(
      Array.from({ length: 8 }, (_, index) => request(result.forward.localPort, `hi-${index}`))
    )
    expect(answers).toEqual(Array.from({ length: 8 }, (_, index) => `echo:hi-${index}`))
    expect(counter.sessions).toBe(1)
    expect(manager.list()[0]).toMatchObject({ totalConnections: 8, remotePort })
  })

  it('streams responses larger than the flow-control window', async () => {
    manager = new RuntimePortForwardManager({ connector: inProcessConnector({ sessions: 0 }) })
    const payload = Buffer.alloc(3 * 1024 * 1024, 7)
    const server = createServer((socket) => socket.end(payload))
    servers.push(server)
    const remotePort = await listen(server)
    const result = await manager.open({
      environmentId: 'e',
      remotePort,
      localPort: 0,
      reason: 'user'
    })
    if (!result.ok) {
      throw new Error('expected forward')
    }
    const received = await new Promise<number>((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port: result.forward.localPort })
      let bytes = 0
      socket.on('data', (chunk) => {
        bytes += chunk.byteLength
      })
      socket.on('end', () => resolve(bytes))
      socket.on('error', reject)
    })
    expect(received).toBe(payload.byteLength)
  })

  it('moves to a nearby port when the same number is busy unless exclusive', async () => {
    manager = new RuntimePortForwardManager({ connector: inProcessConnector({ sessions: 0 }) })
    const remotePort = await echoServer()
    const nearby = await manager.open({ environmentId: 'env-1', remotePort, reason: 'auto' })
    expect(nearby.ok && nearby.forward.localPort).not.toBe(remotePort)
    manager.dispose()
    manager = new RuntimePortForwardManager({ connector: inProcessConnector({ sessions: 0 }) })
    const exclusive = await manager.open({
      environmentId: 'env-1',
      remotePort,
      exclusive: true,
      reason: 'auto'
    })
    expect(exclusive).toMatchObject({ ok: false, code: 'port_busy' })
  })

  it('returns the existing forward for the same remote port and pins auto forwards', async () => {
    manager = new RuntimePortForwardManager({ connector: inProcessConnector({ sessions: 0 }) })
    const remotePort = await echoServer()
    const first = await manager.open({
      environmentId: 'e',
      remotePort,
      localPort: 0,
      reason: 'auto'
    })
    const second = await manager.open({ environmentId: 'e', remotePort, reason: 'user' })
    expect(first.ok && second.ok && first.forward.id === second.forward.id).toBe(true)
    expect(manager.list()[0]?.reason).toBe('user')
  })

  it('fails without binding when the host cannot forward', async () => {
    manager = new RuntimePortForwardManager({
      connector: async () => {
        throw new PortForwardTunnelError('host_unsupported', 'update needed')
      }
    })
    const result = await manager.open({ environmentId: 'e', remotePort: 4321, reason: 'user' })
    expect(result).toMatchObject({ ok: false, code: 'host_unsupported' })
    expect(manager.list()).toEqual([])
  })

  it('records a host-side failure when nothing listens on the remote port', async () => {
    manager = new RuntimePortForwardManager({ connector: inProcessConnector({ sessions: 0 }) })
    const probe = createServer()
    const unused = await listen(probe)
    await new Promise((resolve) => probe.close(resolve))
    const result = await manager.open({
      environmentId: 'e',
      remotePort: unused,
      localPort: 0,
      reason: 'user'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    await request(result.forward.localPort, 'x').catch(() => '')
    await vi.waitFor(() => expect(manager?.list()[0]?.lastError).toBeTruthy())
  })

  it('closes listeners and refuses new connections after close', async () => {
    manager = new RuntimePortForwardManager({ connector: inProcessConnector({ sessions: 0 }) })
    const remotePort = await echoServer()
    const result = await manager.open({
      environmentId: 'e',
      remotePort,
      localPort: 0,
      reason: 'user'
    })
    if (!result.ok) {
      throw new Error('expected forward')
    }
    manager.close(result.forward.id)
    await expect(request(result.forward.localPort, 'x')).rejects.toThrow()
  })
})

describe('createPortForwardDialer', () => {
  it('refuses anything but loopback', () => {
    const dial = createPortForwardDialer({}, () => {
      throw new Error('should not dial')
    })
    for (const host of ['10.0.0.5', 'example.com', '169.254.169.254', 'metadata.google.internal']) {
      expect(() => dial({ host, port: 80 })).toThrow()
    }
  })

  it('dials loopback ports', () => {
    const dialed: { host: string; port: number }[] = []
    const dial = createPortForwardDialer({}, (target) => {
      dialed.push(target)
      return new Socket()
    })
    dial({ host: '127.0.0.1', port: 3000 })
    dial({ host: '::1', port: 5173 })
    expect(dialed).toEqual([
      { host: '127.0.0.1', port: 3000 },
      { host: '::1', port: 5173 }
    ])
  })
})
