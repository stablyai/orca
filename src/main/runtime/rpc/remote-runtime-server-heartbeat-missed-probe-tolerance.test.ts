import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { RemoteRuntimeServerHeartbeat } from './remote-runtime-server-heartbeat'

afterEach(() => {
  vi.useRealTimers()
})

const INTERVAL_MS = 100

function makeSocket(): WebSocket {
  return { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
}

describe('RemoteRuntimeServerHeartbeat missed-probe tolerance', () => {
  it('lets any proof of life reset accumulated misses', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = makeSocket()
    const heartbeat = new RemoteRuntimeServerHeartbeat(INTERVAL_MS, () => now)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])
    now += INTERVAL_MS
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    heartbeat.noteAlive(socket)

    // Two silent probes, then a single inbound frame, repeated well past any fixed budget.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      now += INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      now += INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      heartbeat.noteAlive(socket)
    }

    expect(socket.terminate).not.toHaveBeenCalled()
    heartbeat.stop()
  })

  it('charges no miss for a paused tick but keeps the ones already banked', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = makeSocket()
    const heartbeat = new RemoteRuntimeServerHeartbeat(INTERVAL_MS, () => now)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])
    heartbeat.noteAlive(socket)

    const sweep = async (): Promise<void> => {
      now += INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }
    const reaped = (candidate: WebSocket): boolean =>
      (candidate.terminate as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0

    // Discover the miss budget; the first sweep consumes the existing pong.
    await sweep()
    let toleratedMisses = 0
    // Bound discovery so a broken reaper fails here instead of timing out.
    while (!reaped(socket) && toleratedMisses < 20) {
      await sweep()
      toleratedMisses += 1
    }
    expect(reaped(socket)).toBe(true)
    expect(toleratedMisses).toBeGreaterThan(1)
    heartbeat.stop()

    // Bank misses before suspend: the delayed tick must neither charge an unanswerable probe nor erase prior silence.
    const resumed = new RemoteRuntimeServerHeartbeat(INTERVAL_MS, () => now)
    const resumedSocket = makeSocket()
    resumed.noteAlive(resumedSocket)
    resumed.start(() => [resumedSocket])
    resumed.noteAlive(resumedSocket)
    await sweep()
    for (let miss = 0; miss < toleratedMisses - 1; miss += 1) {
      await sweep()
    }
    expect(reaped(resumedSocket)).toBe(false)

    now += 3_600_000
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(reaped(resumedSocket)).toBe(false)

    await sweep()
    expect(reaped(resumedSocket)).toBe(true)
    resumed.stop()
  })

  // Clearing banked misses on stall formerly sheltered dead sockets forever.
  it('still reaps a dead socket when the host stalls repeatedly', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = makeSocket()
    const heartbeat = new RemoteRuntimeServerHeartbeat(INTERVAL_MS, () => now)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])
    heartbeat.noteAlive(socket)

    const reaped = (): boolean =>
      (socket.terminate as unknown as ReturnType<typeof vi.fn>).mock.calls.length > 0

    // Stall every third tick to reproduce the old perpetual pardon.
    for (let tick = 0; tick < 30 && !reaped(); tick += 1) {
      now += tick % 3 === 2 ? INTERVAL_MS * 2 : INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }

    expect(reaped()).toBe(true)
    heartbeat.stop()
  })
})
