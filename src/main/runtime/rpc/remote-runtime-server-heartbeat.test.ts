import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

afterEach(() => {
  vi.useRealTimers()
})

describe('RemoteRuntimeServerHeartbeat', () => {
  it('does not probe newly connected sockets synchronously on start()', async () => {
    vi.useFakeTimers()
    const socket = { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
    const heartbeat = new RemoteRuntimeServerHeartbeat(100)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])

    // start() must not sweep synchronously during connection handshake
    expect(socket.ping).not.toHaveBeenCalled()

    // Periodic sweep begins on the first interval tick
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

    // Tick #1: probe #1 goes out to both
    now += 100
    await vi.advanceTimersByTimeAsync(100)
    expect(responsiveSocket.ping).toHaveBeenCalledTimes(1)
    expect(deadSocket.ping).toHaveBeenCalledTimes(1)
    heartbeat.noteAlive(responsiveSocket)

    // Tick #2: probe #2 goes out. Silent socket has missed 1 probe (not reaped yet)
    now += 100
    await vi.advanceTimersByTimeAsync(100)
    heartbeat.noteAlive(responsiveSocket)
    expect(deadSocket.ping).toHaveBeenCalledTimes(2)
    expect(deadSocket.terminate).not.toHaveBeenCalled()

    // Tick #3: Miss #2 reaches the limit: consecutive silence is evidence, dead socket reaped
    now += 100
    await vi.advanceTimersByTimeAsync(100)

    expect(responsiveSocket.ping).toHaveBeenCalledTimes(3)
    expect(responsiveSocket.terminate).not.toHaveBeenCalled()
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
    await vi.advanceTimersByTimeAsync(100) // ping #1, socket pongs
    heartbeat.noteAlive(socket)

    now += 100
    await vi.advanceTimersByTimeAsync(100) // ping #2, socket pongs
    heartbeat.noteAlive(socket)

    now += 3_600_000
    await vi.advanceTimersByTimeAsync(100) // resumed-from-pause: re-grants a probe (ping #3), no reap

    expect(socket.ping).toHaveBeenCalledTimes(3)
    expect(socket.terminate).not.toHaveBeenCalled()

    now += 100
    await vi.advanceTimersByTimeAsync(100)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    heartbeat.stop()
  })
})
