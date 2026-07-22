import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteRuntimeServerHeartbeat', () => {
  it('grants clients a fresh probe after the server event loop resumes', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const heartbeat = new RemoteRuntimeServerHeartbeat(100, () => now)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    now += 3_600_000
    await vi.advanceTimersByTimeAsync(100)

    expect(socket.ping).toHaveBeenCalledTimes(2)
    expect(socket.terminate).not.toHaveBeenCalled()

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })
})
