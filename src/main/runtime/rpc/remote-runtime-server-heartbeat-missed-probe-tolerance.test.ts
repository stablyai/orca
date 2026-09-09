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
  it('keeps a client whose pong is merely delayed past one probe window', async () => {
    vi.useFakeTimers()
    let now = 1_000
    const socket = makeSocket()
    const heartbeat = new RemoteRuntimeServerHeartbeat(INTERVAL_MS, () => now)
    heartbeat.noteAlive(socket)
    heartbeat.start(() => [socket])

    // Probe #1 goes out on the first interval tick.
    now += INTERVAL_MS
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(socket.ping).toHaveBeenCalledTimes(1)
    heartbeat.noteAlive(socket) // pongs probe #1

    // A transient blackhole: probe #2 goes out and its pong is stuck in the network.
    now += INTERVAL_MS
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(socket.ping).toHaveBeenCalledTimes(2)
    expect(socket.terminate).not.toHaveBeenCalled()

    // The path recovers and the delayed pong lands right after the next sweep would have run.
    now += INTERVAL_MS
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    heartbeat.noteAlive(socket)

    // One unanswered probe is not evidence the peer is gone: it must still be connected,
    // and it must have been re-probed rather than reaped.
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(socket.ping).toHaveBeenCalledTimes(3)
    heartbeat.stop()
  })

  it('reaps only after consecutive probes go unanswered, counted not timed', async () => {
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

    const missesBeforeReap: number[] = []
    for (let probe = 0; probe < 6; probe += 1) {
      now += INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      missesBeforeReap.push(
        (socket.terminate as unknown as ReturnType<typeof vi.fn>).mock.calls.length
      )
    }

    // Silence must be tolerated for more than a single probe, and must eventually end the socket.
    expect(missesBeforeReap[0]).toBe(0)
    expect(missesBeforeReap[1]).toBe(0)
    expect(missesBeforeReap.at(-1)).toBeGreaterThan(0)
    heartbeat.stop()
  })

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

    // Discover the budget rather than hardcoding it: the first sweep consumes the pong above, so
    // every sweep after it is an unanswered probe.
    await sweep()
    let toleratedMisses = 0
    // Bounded so a heartbeat that never reaps fails here instead of hanging out to the test timeout.
    while (!reaped(socket) && toleratedMisses < 20) {
      await sweep()
      toleratedMisses += 1
    }
    expect(reaped(socket)).toBe(true)
    expect(toleratedMisses).toBeGreaterThan(1)
    heartbeat.stop()

    // Replay on a fresh socket: bank misses to one short of the limit, then suspend. The stalled tick
    // must charge nothing — the client had no chance to answer it — but it must not forgive the misses
    // already banked, or a host that stalls periodically could shelter a dead socket indefinitely.
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
    // The suspend itself costs the socket nothing.
    expect(reaped(resumedSocket)).toBe(false)

    // But the pre-suspend evidence survives, so the very next unanswered probe completes the budget.
    await sweep()
    expect(reaped(resumedSocket)).toBe(true)
    resumed.stop()
  })

  // Why: pre-fix the pardon cleared banked misses, so a host stalling once every few ticks reset the
  // budget forever and a dead socket was never reaped — the connection leak the reaper exists to stop.
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

    // Stall every third tick — the worst case the old pardon could not survive.
    for (let tick = 0; tick < 30 && !reaped(); tick += 1) {
      now += tick % 3 === 2 ? INTERVAL_MS * 2 : INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }

    expect(reaped()).toBe(true)
    heartbeat.stop()
  })
})
