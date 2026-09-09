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
    transport.setClientId(socket, 'client')
    await vi.advanceTimersByTimeAsync(100)

    expect(firstProbeListeners).toEqual({ pong: 1, message: 1, close: 1, error: 1 })
    expect(events.slice(0, 4)).toEqual(['open', 'ping', 'ready', 'pong'])
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(lifecycle.heartbeatConnections.size).toBe(1)
    expect(vi.getTimerCount()).toBe(1)

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

  it('reaps an unresponsive accepted socket once consecutive probes go unanswered', async () => {
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
    const { lifecycle, transport } = createHarness(socket)

    socket.once('open', () => events.push('open'))
    socket.emit('open')
    lifecycle.handleConnection(socket)
    transport.setClientId(socket, 'client')
    expect(socket.terminate).not.toHaveBeenCalled()
    // A single silent interval is not evidence: the socket is re-probed, not reaped.
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.terminate).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(299)
    expect(socket.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(events).toEqual(['open', 'ping', 'ping', 'ping', 'close'])
    expect(lifecycle.heartbeatConnections.size).toBe(0)
    expect(lifecycle.heartbeat.timer).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps later sockets on the shared cadence and reaps them on the shared budget', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const firstPingTimes: number[] = []
    let firstSocket: WebSocket
    firstSocket = createSocket({
      ping: () => {
        firstPingTimes.push(Date.now())
        firstSocket.emit('pong')
      }
    })
    const { lifecycle, transport } = createHarness(firstSocket)

    lifecycle.handleConnection(firstSocket)
    transport.setClientId(firstSocket, 'first-client')
    const sharedTimer = lifecycle.heartbeat.timer
    expect(firstPingTimes).toEqual([])

    await vi.advanceTimersByTimeAsync(50)
    const laterPingTimes: number[] = []
    const laterReapTimes: number[] = []
    let laterSocket: WebSocket
    laterSocket = createSocket({
      ping: () => laterPingTimes.push(Date.now()),
      terminate: () => {
        laterReapTimes.push(Date.now())
        laterSocket.emit('close')
      }
    })
    lifecycle.wss.clients.add(laterSocket)
    lifecycle.handleConnection(laterSocket)

    expect(lifecycle.heartbeat.timer).toBe(sharedTimer)
    expect(laterPingTimes).toEqual([])
    expect(vi.getTimerCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(50)
    expect(laterPingTimes).toEqual([])
    expect(laterSocket.terminate).not.toHaveBeenCalled()

    transport.setClientId(laterSocket, 'later-client')
    await vi.advanceTimersByTimeAsync(100)
    expect(laterPingTimes).toEqual([200])

    // Re-probed on every sweep while its misses bank, so a recovered path can answer immediately.
    await vi.advanceTimersByTimeAsync(299)
    expect(laterPingTimes).toEqual([200, 300, 400])
    expect(laterSocket.terminate).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(laterSocket.terminate).toHaveBeenCalledTimes(1)
    expect(laterReapTimes).toEqual([500])
    expect(firstPingTimes).toEqual([100, 200, 300, 400, 500])
    expect(
      ['pong', 'message', 'close', 'error'].map((event) => laterSocket.listenerCount(event))
    ).toEqual([0, 0, 0, 0])

    firstSocket.emit('close')
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
    const { lifecycle, transport } = createHarness(socket)

    socket.once('open', () => events.push('open'))
    socket.emit('open')
    lifecycle.handleConnection(socket)
    transport.setClientId(socket, 'client')
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
