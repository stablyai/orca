import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { AcceptedSocketLiveness } from './accepted-socket-liveness'

const INTERVAL_MS = 100
const PRE_AUTH_TIMEOUT_MS = 250

function makeSocket(): WebSocket {
  return { ping: vi.fn(), terminate: vi.fn() } as unknown as WebSocket
}

function timerOf(liveness: AcceptedSocketLiveness): ReturnType<typeof setInterval> | null {
  return (liveness as unknown as { heartbeat: { timer: ReturnType<typeof setInterval> | null } })
    .heartbeat.timer
}

afterEach(() => {
  vi.useRealTimers()
})

// The invariant this class exists for: between accept() and release(), a socket is always under
// exactly one liveness bound — the pre-auth deadline before authenticate(), the heartbeat after.
describe('AcceptedSocketLiveness', () => {
  it('terminates a never-authenticated socket at the pre-auth deadline without ever probing it', async () => {
    vi.useFakeTimers()
    let now = 0
    const liveness = new AcceptedSocketLiveness(PRE_AUTH_TIMEOUT_MS, INTERVAL_MS, () => now)
    const socket = makeSocket()
    liveness.accept(socket)
    expect(timerOf(liveness)).not.toBeNull()

    now += PRE_AUTH_TIMEOUT_MS
    await vi.advanceTimersByTimeAsync(PRE_AUTH_TIMEOUT_MS)

    expect(socket.ping).not.toHaveBeenCalled()
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    liveness.release(socket)
    expect(timerOf(liveness)).toBeNull()
  })

  it('swaps the deadline for heartbeat probing on authenticate, then reaps on the miss budget', async () => {
    vi.useFakeTimers()
    let now = 0
    const liveness = new AcceptedSocketLiveness(PRE_AUTH_TIMEOUT_MS, INTERVAL_MS, () => now)
    const socket = makeSocket()
    liveness.accept(socket)
    liveness.authenticate(socket)

    // Pre-auth deadline is cancelled: nothing fires at its horizon but interval ticks.
    // First probe lands on the first tick; a silent socket then banks misses to the budget.
    for (const elapsed of [100, 200, 300]) {
      now = elapsed
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
      expect(socket.ping).toHaveBeenCalledTimes(elapsed / INTERVAL_MS)
      expect(socket.terminate).not.toHaveBeenCalled()
    }
    now = 400
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    expect(socket.terminate).toHaveBeenCalledTimes(1)
    liveness.release(socket)
  })

  it('keeps a responsive authenticated socket alive indefinitely', async () => {
    vi.useFakeTimers()
    let now = 0
    const liveness = new AcceptedSocketLiveness(PRE_AUTH_TIMEOUT_MS, INTERVAL_MS, () => now)
    const socket = makeSocket()
    liveness.accept(socket)
    liveness.authenticate(socket)

    for (let tick = 1; tick <= 10; tick++) {
      liveness.noteAlive(socket)
      now = tick * INTERVAL_MS
      await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    }
    expect(socket.terminate).not.toHaveBeenCalled()
    expect(socket.ping).toHaveBeenCalledTimes(10)
    liveness.release(socket)
  })

  it('release clears the pre-auth deadline and stops the shared timer on the last socket', async () => {
    vi.useFakeTimers()
    let now = 0
    const liveness = new AcceptedSocketLiveness(PRE_AUTH_TIMEOUT_MS, INTERVAL_MS, () => now)
    const first = makeSocket()
    const second = makeSocket()
    liveness.accept(first)
    const sharedTimer = timerOf(liveness)
    liveness.accept(second)
    expect(timerOf(liveness)).toBe(sharedTimer)

    liveness.release(first)
    expect(timerOf(liveness)).toBe(sharedTimer)
    liveness.release(second)
    expect(timerOf(liveness)).toBeNull()

    now += PRE_AUTH_TIMEOUT_MS * 2
    await vi.advanceTimersByTimeAsync(PRE_AUTH_TIMEOUT_MS * 2)
    expect(first.terminate).not.toHaveBeenCalled()
    expect(second.terminate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stop clears membership so a restarted sweep cannot probe stale sockets', async () => {
    vi.useFakeTimers()
    let now = 0
    const liveness = new AcceptedSocketLiveness(PRE_AUTH_TIMEOUT_MS, INTERVAL_MS, () => now)
    const stale = makeSocket()
    liveness.accept(stale)
    liveness.authenticate(stale)
    liveness.stop()

    const fresh = makeSocket()
    liveness.accept(fresh)
    liveness.authenticate(fresh)
    now += INTERVAL_MS
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)

    expect(stale.ping).not.toHaveBeenCalled()
    expect(fresh.ping).toHaveBeenCalledTimes(1)
    liveness.release(fresh)
  })
})
