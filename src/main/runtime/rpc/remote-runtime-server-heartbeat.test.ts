import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'
import { setActiveSink } from '../../observability/tracer'

afterEach(() => {
  setActiveSink(null)
  vi.useRealTimers()
})

describe('RemoteRuntimeServerHeartbeat', () => {
  it('defers the first probe until after the WebSocket handshake window', async () => {
    vi.useFakeTimers()
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const heartbeat = new RemoteRuntimeServerHeartbeat(100)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])

    expect(socket.ping).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(100)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })

  it('still reaps a persistently silent client while another remains alive', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const responsiveSocket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const deadSocket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    // Limit of 2 keeps the sweep count readable; production uses the module default.
    const heartbeat = new RemoteRuntimeServerHeartbeat(100, () => now, 128, 2)
    heartbeat.noteAlive(responsiveSocket)
    heartbeat.noteAlive(deadSocket)
    heartbeat.start(() => [responsiveSocket, deadSocket])
    expect(responsiveSocket.ping).not.toHaveBeenCalled()
    expect(deadSocket.ping).not.toHaveBeenCalled()

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    heartbeat.noteAlive(responsiveSocket)

    // First miss re-probes without reaping.
    now += 100
    await vi.advanceTimersByTimeAsync(100)
    heartbeat.noteAlive(responsiveSocket)
    expect(deadSocket.ping).toHaveBeenCalledTimes(2)
    expect(deadSocket.terminate).not.toHaveBeenCalled()

    // Consecutive silence reaches the configured limit.
    now += 100
    await vi.advanceTimersByTimeAsync(100)

    expect(responsiveSocket.ping).toHaveBeenCalledTimes(3)
    expect(responsiveSocket.terminate).not.toHaveBeenCalled()
    expect(deadSocket.ping).toHaveBeenCalledTimes(2)
    expect(deadSocket.terminate).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })

  it('grants clients a fresh probe after the server event loop resumes', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    // Limit of 1 isolates the resume grant: without it the very next sweep would reap.
    const heartbeat = new RemoteRuntimeServerHeartbeat(100, () => now, 128, 1)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])
    now += 100
    await vi.advanceTimersByTimeAsync(100)
    heartbeat.noteAlive(socket)

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    heartbeat.noteAlive(socket)
    now += 3_600_000
    await vi.advanceTimersByTimeAsync(100)

    expect(socket.ping).toHaveBeenCalledTimes(3)
    expect(socket.terminate).not.toHaveBeenCalled()

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })

  it('writes a trace span for each reap with the socket uptime and last round trip', async () => {
    vi.useFakeTimers()
    const records: unknown[] = []
    setActiveSink({ push: (record) => records.push(record), flush() {}, close() {} })
    let now = 1_000
    // SAFETY: the heartbeat only calls ping() and terminate() on its sockets.
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const heartbeat = new RemoteRuntimeServerHeartbeat(100, () => now, 128, 1)
    heartbeat.track(socket)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])
    now += 100
    await vi.advanceTimersByTimeAsync(100)
    now += 40
    heartbeat.notePong(socket)

    now += 60
    await vi.advanceTimersByTimeAsync(100)
    now += 100
    await vi.advanceTimersByTimeAsync(100)

    expect(socket.terminate).toHaveBeenCalledTimes(1)
    expect(records).toEqual([
      expect.objectContaining({
        name: 'remote-runtime.server-socket-reaped',
        attributes: expect.objectContaining({
          cause: 'heartbeat_missed_probes',
          lastRttMs: 40,
          socketUptimeMs: 300,
          trackedSockets: 1
        })
      })
    ])
    heartbeat.stop()
  })
})
