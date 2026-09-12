import { afterEach, describe, expect, it, vi } from 'vitest'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'
import { BunWebSocketTransport } from './bun-websocket-transport'
import {
  WEBSOCKET_TRANSPORT_MAX_BACKPRESSURE_BYTES,
  WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES
} from './websocket-transport-limits'

type ServeOptions = {
  hostname: string
  port: number
  idleTimeout: number
  maxRequestBodySize: number
  fetch(request: Request, server: { upgrade(request: Request): boolean }): Response | undefined
  websocket: {
    maxPayloadLength: number
    backpressureLimit: number
    closeOnBackpressureLimit: boolean
    open(socket: BunSocket): void
    message(socket: BunSocket, message: string | ArrayBuffer | Uint8Array): void
    close(socket: BunSocket): void
    error(socket: BunSocket, error: unknown): void
  }
}

type BunSocket = {
  data: unknown
  readyState: number
  getBufferedAmount(): number
  send(data: unknown): number
  close(code?: number, reason?: string): void
  terminate(): void
  ping(): void
}

function socket(): BunSocket {
  return {
    data: {},
    readyState: 1,
    getBufferedAmount: vi.fn(() => 9 * 1024 * 1024),
    send: vi.fn(() => 1),
    close: vi.fn(),
    terminate: vi.fn(),
    ping: vi.fn()
  }
}

function setup(stop = vi.fn()) {
  const captured: { options?: ServeOptions } = {}
  vi.stubGlobal('Bun', {
    serve: vi.fn((candidate: ServeOptions) => {
      captured.options = candidate
      return { hostname: candidate.hostname, port: 43123, upgrade: vi.fn(), stop }
    })
  })
  const heartbeat = new RemoteRuntimeServerHeartbeat(10_000, undefined, 128)
  const messageHandler = vi.fn()
  const connectionCloseHandler = vi.fn()
  const transport = new BunWebSocketTransport({
    preAuthTimeoutMs: 10_000,
    heartbeat,
    callbacks: { messageHandler, connectionCloseHandler }
  })
  transport.start()
  const options = captured.options
  if (!options) {
    throw new Error('Bun serve options were not captured')
  }
  return { connectionCloseHandler, messageHandler, options, stop, transport }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Bun WebSocket transport', () => {
  it('binds an internal loopback endpoint with payload and backpressure limits', () => {
    const { options, transport } = setup()

    expect(options).toMatchObject({
      hostname: '127.0.0.1',
      port: 0,
      idleTimeout: 10,
      maxRequestBodySize: WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES
    })
    expect(options.websocket).toMatchObject({
      maxPayloadLength: WEBSOCKET_TRANSPORT_MAX_MESSAGE_BYTES,
      backpressureLimit: WEBSOCKET_TRANSPORT_MAX_BACKPRESSURE_BYTES,
      closeOnBackpressureLimit: true
    })
    expect(transport.port).toBe(43123)
  })

  it('adapts messages and finalizes an errored socket exactly once', () => {
    const { connectionCloseHandler, messageHandler, options, transport } = setup()
    const raw = socket()
    options.websocket.open(raw)
    options.websocket.message(raw, 'hello')

    expect(messageHandler).toHaveBeenCalledOnce()
    const adapted = messageHandler.mock.calls[0]?.[2]
    expect(adapted.bufferedAmount).toBe(9 * 1024 * 1024)
    transport.setClientId(adapted, 'client-1')
    options.websocket.error(raw, new Error('socket failed'))
    options.websocket.close(raw)

    expect(raw.terminate).toHaveBeenCalledOnce()
    expect(connectionCloseHandler).toHaveBeenCalledOnce()
    expect(connectionCloseHandler).toHaveBeenCalledWith('client-1', adapted, false)
  })

  it('reserves pending upgrades so concurrent handshakes cannot exceed the client cap', async () => {
    const { options, transport } = setup()
    const upgrade = vi.fn(() => true)
    const server = { upgrade }
    const request = () => new Request('http://127.0.0.1/', { headers: { upgrade: 'websocket' } })

    for (let index = 0; index < 128; index += 1) {
      expect(options.fetch(request(), server)).toBeUndefined()
    }
    const rejected = options.fetch(request(), server)

    expect(rejected).toBeInstanceOf(Response)
    expect((rejected as Response).status).toBe(503)
    expect(upgrade).toHaveBeenCalledTimes(128)
    await transport.stop()
  })

  it('terminates an upgrade that opens after transport shutdown', async () => {
    const { options, transport } = setup()
    const raw = socket()

    await transport.stop()
    options.websocket.open(raw)

    expect(raw.terminate).toHaveBeenCalledOnce()
  })

  it('finalizes clients even when native server shutdown rejects', async () => {
    const stop = vi.fn().mockRejectedValue(new Error('stop failed'))
    const { connectionCloseHandler, options, transport } = setup(stop)
    const raw = socket()
    options.websocket.open(raw)

    await expect(transport.stop()).rejects.toThrow('stop failed')

    expect(raw.terminate).toHaveBeenCalledOnce()
    expect(connectionCloseHandler).toHaveBeenCalledOnce()
  })
})
