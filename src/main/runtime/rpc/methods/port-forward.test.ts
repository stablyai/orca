import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PORT_FORWARD_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { RpcDispatcher } from '../dispatcher'
import { ALL_RPC_METHODS } from './index'
import {
  PORT_FORWARD_METHODS,
  connectLoopbackForwardDestination,
  createPortForwardMethods
} from './port-forward'

const servers: Server[] = []

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()?.close()
  }
})

function listenLoopback(onData: (chunk: string) => void): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.on('data', (chunk) => {
        onData(chunk.toString())
        socket.end('pong')
      })
    })
    servers.push(server)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
}

function request() {
  return {
    id: 'port-forward',
    authToken: 'bound-by-websocket',
    method: 'network.portForward',
    params: {}
  }
}

function runtime(cleanups = new Map<string, () => void>()): OrcaRuntimeService {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: network.portForward reads nothing off OrcaRuntimeService; the dispatcher touches only these three members, and stubbing the whole service would assert far more than this test exercises.
  return {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: (id: string, cleanup: () => void) => cleanups.set(id, cleanup)
  } as unknown as OrcaRuntimeService
}

function baseOptions() {
  return {
    connectionId: 'connection-a',
    clientKind: 'runtime' as const,
    pairedDeviceId: 'device-a',
    sendBinary: vi.fn(() => true),
    // Production hands back an unregister function; returning one keeps the mock honest.
    registerBinaryMessageHandler: vi.fn(() => vi.fn())
  }
}

describe('network.portForward registration', () => {
  it('is registered in production', () => {
    expect(ALL_RPC_METHODS.some((method) => method.name === 'network.portForward')).toBe(true)
  })

  it('is advertised in runtime status, not only registered', () => {
    // getStatus() builds its advertised set from RUNTIME_CAPABILITIES, so a method that
    // is registered but missing from it reads to every client as a host predating it.
    expect(RUNTIME_CAPABILITIES).toContain(PORT_FORWARD_RUNTIME_CAPABILITY)
  })
})

describe('network.portForward admission', () => {
  it('refuses a client that did not negotiate the capability, before any binary traffic', async () => {
    const dispatcher = new RpcDispatcher({ runtime: runtime(), methods: PORT_FORWARD_METHODS })
    const replies: string[] = []
    const options = baseOptions()

    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), options)

    expect(JSON.parse(replies[0])).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'port_forward_capability_required' })
      })
    )
    expect(options.registerBinaryMessageHandler).not.toHaveBeenCalled()
  })

  it('refuses a connection that is not an authenticated paired binary client', async () => {
    const dispatcher = new RpcDispatcher({ runtime: runtime(), methods: PORT_FORWARD_METHODS })
    const replies: string[] = []

    await dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
      ...baseOptions(),
      pairedDeviceId: undefined,
      clientCapabilities: [PORT_FORWARD_RUNTIME_CAPABILITY]
    })

    expect(JSON.parse(replies[0])).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ message: 'authenticated_binary_port_forward_required' })
      })
    )
  })

  it('announces a ready generation and accepts binary traffic once negotiated', async () => {
    const dispatcher = new RpcDispatcher({
      runtime: runtime(),
      methods: createPortForwardMethods(() => {
        throw new Error('no destination needed for this assertion')
      })
    })
    const replies: string[] = []
    const options = baseOptions()
    const controller = new AbortController()

    const dispatched = dispatcher.dispatchStreaming(request(), (reply) => replies.push(reply), {
      ...options,
      clientCapabilities: [PORT_FORWARD_RUNTIME_CAPABILITY],
      signal: controller.signal
    })
    await vi.waitFor(() => expect(replies.length).toBeGreaterThan(0))
    controller.abort()
    await dispatched

    const ready = JSON.parse(replies[0])
    expect(ready.ok).toBe(true)
    expect(ready.result.type).toBe('ready')
    expect(ready.result.tunnelGeneration).toBeGreaterThanOrEqual(1)
    expect(options.registerBinaryMessageHandler).toHaveBeenCalledTimes(1)
  })
})

describe('connectLoopbackForwardDestination', () => {
  it('connects to a real loopback listener and carries bytes both ways', async () => {
    const received: string[] = []
    const port = await listenLoopback((chunk) => received.push(chunk))

    const socket = connectLoopbackForwardDestination({ host: '127.0.0.1', port })
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('connect', () => socket.write(new TextEncoder().encode('ping')))
      socket.on('data', (chunk: Uint8Array) => resolve(new TextDecoder().decode(chunk)))
      socket.on('error', reject)
    })

    expect(received).toEqual(['ping'])
    expect(reply).toBe('pong')
    socket.destroy()
  })

  it('dials the validated literal rather than the string it was handed', async () => {
    const received: string[] = []
    const port = await listenLoopback((chunk) => received.push(chunk))

    // `[127.0.0.1]` is not valid dial input — it reaches the listener only because the
    // bracket-stripped literal is what gets connected. Passing the raw string would send
    // it to getaddrinfo, which resolves such forms as names.
    const socket = connectLoopbackForwardDestination({ host: '[127.0.0.1]', port })
    const reply = await new Promise<string>((resolve, reject) => {
      socket.on('connect', () => socket.write(new TextEncoder().encode('ping')))
      socket.on('data', (chunk: Uint8Array) => resolve(new TextDecoder().decode(chunk)))
      socket.on('error', reject)
    })

    expect(reply).toBe('pong')
    socket.destroy()
  })

  it('refuses a leading-zero octet a resolver would answer as a hostname', () => {
    expect(() => connectLoopbackForwardDestination({ host: '127.0.0.08', port: 80 })).toThrow(
      'port_forward_destination_refused'
    )
  })

  it('refuses a routable destination instead of dialling it', () => {
    // The browser tunnel accepts any destination because a browser-host lease scopes
    // it. A forward has no such scope, so the destination itself is the boundary.
    expect(() => connectLoopbackForwardDestination({ host: '100.64.1.20', port: 8080 })).toThrow(
      'port_forward_destination_refused'
    )
    expect(() => connectLoopbackForwardDestination({ host: '169.254.169.254', port: 80 })).toThrow(
      'port_forward_destination_refused'
    )
    expect(() => connectLoopbackForwardDestination({ host: 'example.com', port: 443 })).toThrow(
      'port_forward_destination_refused'
    )
    expect(() =>
      connectLoopbackForwardDestination({ host: '127.evil.example.com', port: 80 })
    ).toThrow('port_forward_destination_refused')
  })

  it('refuses an out-of-range port', () => {
    expect(() => connectLoopbackForwardDestination({ host: '127.0.0.1', port: 0 })).toThrow(
      'port_forward_destination_refused'
    )
    expect(() => connectLoopbackForwardDestination({ host: '127.0.0.1', port: 70000 })).toThrow(
      'port_forward_destination_refused'
    )
  })
})
