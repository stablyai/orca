import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteRuntimeServerHeartbeat', () => {
  it('still reaps a client that misses a probe while another remains alive', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const responsiveSocket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const deadSocket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const heartbeat = new RemoteRuntimeServerHeartbeat(100, () => now)

    heartbeat.noteAlive(responsiveSocket)
    heartbeat.noteAlive(deadSocket)
    heartbeat.start(() => [responsiveSocket, deadSocket])

    now += 100
    await vi.advanceTimersByTimeAsync(100)

    // Only the responsive socket answers the first interval probe.
    heartbeat.noteAlive(responsiveSocket)

    now += 100
    await vi.advanceTimersByTimeAsync(100)

    expect(responsiveSocket.ping).toHaveBeenCalledTimes(2)
    expect(responsiveSocket.terminate).not.toHaveBeenCalled()
    expect(deadSocket.ping).toHaveBeenCalledTimes(1)
    expect(deadSocket.terminate).toHaveBeenCalledTimes(1)

    heartbeat.stop()
  })

  it('grants clients a fresh probe after the server event loop resumes', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const heartbeat = new RemoteRuntimeServerHeartbeat(100, () => now)

    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])

    now += 100
    await vi.advanceTimersByTimeAsync(100) // first interval probe (ping #1)
    heartbeat.noteAlive(socket)

    now += 3_600_000
    await vi.advanceTimersByTimeAsync(100) // resumed-from-pause: re-grants a probe (ping #2), no reap

    expect(socket.ping).toHaveBeenCalledTimes(2)
    expect(socket.terminate).not.toHaveBeenCalled()

    now += 100
    await vi.advanceTimersByTimeAsync(100)

    expect(socket.terminate).toHaveBeenCalledTimes(1)

    heartbeat.stop()
  })
})
