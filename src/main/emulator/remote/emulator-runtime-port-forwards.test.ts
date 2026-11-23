import { connect, createServer, type AddressInfo, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserNetworkTunnelSession } from '../../browser/network/tunnels/browser-network-tunnel-session'
import { BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL } from '../../browser/network/tunnels/browser-network-tunnel-stream-state'
import { BrowserTunnelDestinationBlockedError } from '../../browser/network/tunnels/browser-network-tunnel-destination-policy'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { emulatorTunnelTargetAllowed } from '../emulator-tunnel-target-policy'
import { EmulatorRuntimeTunnelTransport } from './emulator-runtime-tunnel-transport'
import { EmulatorRuntimePortForwards } from './emulator-runtime-port-forwards'

const servers: Server[] = []
const forwards: EmulatorRuntimePortForwards[] = []

afterEach(async () => {
  forwards.splice(0).forEach((forward) => forward.close())
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))))
})

async function listenEcho(): Promise<number> {
  const server = createServer((socket) => socket.pipe(socket))
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address: AddressInfo | string | null = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('echo server has no port')
  }
  return address.port
}

/** Wires the runtime's tunnel session to the client transport as `emulator.tunnel` would. */
function forwardsToRuntime(helperEndpointUrls: string[]): EmulatorRuntimePortForwards {
  const transport = new EmulatorRuntimeTunnelTransport('test', async (callbacks) => {
    const session = new BrowserNetworkTunnelSession({
      tunnelGeneration: 1,
      connect: (target) => {
        if (!emulatorTunnelTargetAllowed(target, helperEndpointUrls)) {
          throw new BrowserTunnelDestinationBlockedError('orca_listener')
        }
        return connect({ host: target.host, port: target.port, allowHalfOpen: true })
      },
      sendBinary: (bytes) => {
        const copy = bytes.slice()
        setImmediate(() => callbacks.onBinary?.(copy))
        return true
      },
      flowControl: BROWSER_NETWORK_TUNNEL_WINDOW_V2_FLOW_CONTROL
    })
    setImmediate(() =>
      callbacks.onResponse({
        id: 'emulator-tunnel',
        ok: true,
        result: { type: 'ready', tunnelGeneration: 1 },
        _meta: { runtimeId: 'runtime' }
      } satisfies RuntimeRpcResponse<unknown>)
    )
    return {
      requestId: 'emulator-tunnel',
      close: () => session.close(),
      sendBinary: (bytes) => {
        const copy = bytes.slice()
        setImmediate(() => session.handleBinary(copy))
        return true
      }
    }
  })
  const forward = new EmulatorRuntimePortForwards((target) => transport.open(target))
  forwards.push(forward)
  return forward
}

function roundTrip(localPort: number, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port: localPort })
    let received = ''
    socket.on('data', (chunk) => {
      received += chunk.toString()
      if (received.length >= payload.length) {
        socket.destroy()
      }
    })
    socket.on('error', () => {})
    socket.on('close', () => resolve(received))
    socket.write(payload)
  })
}

describe('emulator runtime port forwards', () => {
  it('carries a local connection to the runtime helper port through the tunnel', async () => {
    const helperPort = await listenEcho()
    const forward = forwardsToRuntime([`http://127.0.0.1:${helperPort}/stream.mjpeg`])

    const localPort = await forward.localPortFor(helperPort)

    expect(localPort).not.toBe(helperPort)
    expect(await roundTrip(localPort, 'GET /stream.avcc')).toBe('GET /stream.avcc')
  })

  it('refuses runtime ports that no simulator helper registered', async () => {
    const helperPort = await listenEcho()
    const otherPort = await listenEcho()
    const forward = forwardsToRuntime([`ws://127.0.0.1:${helperPort}/ws`])

    const localPort = await forward.localPortFor(otherPort)

    expect(await roundTrip(localPort, 'GET /')).toBe('')
  })
})

describe('emulator runtime port forward retirement', () => {
  it('rejects a forward closed before its listener binds instead of hanging', async () => {
    const forward = new EmulatorRuntimePortForwards(() => Promise.reject(new Error('unused')))
    const pending = forward.localPortFor(41_000)
    forward.close()

    await expect(pending).rejects.toThrow('Emulator stream forward closed')
  })
})

describe('emulatorTunnelTargetAllowed', () => {
  const endpoints = ['http://127.0.0.1:3100/stream.mjpeg', 'ws://localhost:3101/ws', 'scrcpy://abc']

  it('admits only loopback hosts on registered helper ports', () => {
    expect(emulatorTunnelTargetAllowed({ host: '127.0.0.1', port: 3100 }, endpoints)).toBe(true)
    expect(emulatorTunnelTargetAllowed({ host: '::1', port: 3101 }, endpoints)).toBe(true)
    expect(emulatorTunnelTargetAllowed({ host: '127.0.0.1', port: 22 }, endpoints)).toBe(false)
    expect(emulatorTunnelTargetAllowed({ host: '192.168.1.5', port: 3100 }, endpoints)).toBe(false)
    expect(emulatorTunnelTargetAllowed({ host: 'example.com', port: 3100 }, endpoints)).toBe(false)
  })
})
