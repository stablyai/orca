import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { WebSocketTransport } from './ws-transport'

type TransportLifecycle = {
  heartbeat: { timer: ReturnType<typeof setInterval> | null }
  heartbeatConnections: Set<WebSocket>
  handleConnection(ws: WebSocket): void
  wss: { clients: Set<WebSocket> }
}

function createSocket(overrides: { ping?: () => void; terminate?: () => void } = {}): WebSocket {
  return Object.assign(new EventEmitter(), {
    OPEN: WebSocket.OPEN,
    readyState: WebSocket.OPEN,
    close: vi.fn(),
    ping: vi.fn(overrides.ping),
    send: vi.fn(),
    terminate: vi.fn(overrides.terminate)
  }) as unknown as WebSocket
}

function createHarness(socket: WebSocket): {
  lifecycle: TransportLifecycle
  transport: WebSocketTransport
} {
  const transport = new WebSocketTransport({
    host: '127.0.0.1',
    port: 0,
    heartbeatIntervalMs: 100,
    preAuthTimeoutMs: 1_000
  })
  const lifecycle = transport as unknown as TransportLifecycle
  lifecycle.wss = { clients: new Set([socket]) }
  return { lifecycle, transport }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WebSocketTransport accepted socket ordering', () => {
  it('observes a first-probe message and pong before deciding the socket is dead', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    let firstProbeListeners: Record<string, number> | undefined
    let socket: WebSocket
    socket = createSocket({
      ping: () => {
        events.push('ping')
        firstProbeListeners ??= Object.fromEntries(
          ['pong', 'message', 'close', 'error'].map((event) => [event, socket.listenerCount(event)])
        )
        socket.emit('message', Buffer.from('ready'), false)
        events.push('pong')
        socket.emit('pong')
      }
    })
    const { lifecycle, transport } = createHarness(socket)
    transport.onMessage((message) => events.push(String(message)))

    socket.once('open', () => events.push('open'))
    socket.emit('open')
    lifecycle.handleConnection(socket)
    await vi.advanceTimersByTimeAsync(100)

    expect(firstProbeListeners).toEqual({ pong: 1, message: 1, close: 1, error: 1 })
    expect(events.slice(0, 4)).toEqual(['open', 'ping', 'ready', 'pong'])
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(lifecycle.heartbeatConnections.size).toBe(1)
    expect(vi.getTimerCount()).toBe(2)

    events.push('close')
    socket.emit('close')

    expect(events.at(-1)).toBe('close')
    expect(lifecycle.heartbeatConnections.size).toBe(0)
    expect(lifecycle.heartbeat.timer).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(
      ['pong', 'message', 'close', 'error'].map((event) => socket.listenerCount(event))
    ).toEqual([0, 0, 0, 0])
  })

  it('reaps an unresponsive accepted socket by the first interval deadline', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    let socket: WebSocket
    socket = createSocket({
      ping: () => events.push('ping'),
      terminate: () => {
        events.push('close')
        socket.emit('close')
      }
    })
    const { lifecycle } = createHarness(socket)

    socket.once('open', () => events.push('open'))
    socket.emit('open')
    lifecycle.handleConnection(socket)
    await vi.advanceTimersByTimeAsync(99)
    expect(socket.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['open', 'ping', 'close'])
    expect(lifecycle.heartbeatConnections.size).toBe(0)
    expect(lifecycle.heartbeat.timer).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('finalizes an accepted socket when the first probe reports an error', async () => {
    vi.useFakeTimers()
    const events: string[] = []
    let socket: WebSocket
    socket = createSocket({
      ping: () => {
        events.push('ping', 'error')
        socket.emit('error', new Error('probe failed'))
      }
    })
    const { lifecycle } = createHarness(socket)

    socket.once('open', () => events.push('open'))
    socket.emit('open')
    lifecycle.handleConnection(socket)
    await vi.advanceTimersByTimeAsync(100)
    events.push('close')
    socket.emit('close')

    expect(events.slice(0, 4)).toEqual(['open', 'ping', 'error', 'close'])
    expect(socket.close).toHaveBeenCalledTimes(1)
    expect(lifecycle.heartbeatConnections.size).toBe(0)
    expect(lifecycle.heartbeat.timer).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})
