import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayIdleStop } from '../provider-relay-idle-stop'
import { readProviderRelayDetachPolicy } from '../provider-relay-detach-policy'
import {
  providerRelayStopFlags,
  ProviderRelayDetachedCap,
  RELAY_DETACHED_CAP_MS,
  type CappableRelay
} from '../provider-relay-detached-cap'
import { CODEX_RELAY_WORK_MARKERS } from '../../../codex/app-server/codex-app-server-relay'

const IDLE_MS = 30 * 60_000
const HOUR = 60 * 60_000

function relay(
  id: string,
  state: { tracking: boolean; unread: boolean; finished?: boolean }
): CappableRelay {
  return {
    relayId: id,
    live: true,
    attachedClientId: null,
    idleStopPolicy: { finished: false, ...state },
    stoppedBy: null,
    close: vi.fn(async () => {})
  }
}

describe('a detached agent with output no app took', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('is never idle-stopped while that output is unread', async () => {
    const stop = vi.fn()
    const unread = { value: true }
    const idle = new ProviderRelayIdleStop({
      attached: () => false,
      live: () => true,
      pendingCount: () => 0,
      unacked: () => [],
      unread: () => unread.value,
      stop
    })
    const policy = readProviderRelayDetachPolicy({
      idleStopMs: IDLE_MS,
      markers: CODEX_RELAY_WORK_MARKERS.markers,
      open: {}
    })
    expect(policy).not.toBeNull()
    idle.arm(policy)
    await vi.advanceTimersByTimeAsync(IDLE_MS * 4)
    expect(stop).not.toHaveBeenCalled()
    // Read (an app took it, then let go again): the idle rule applies as usual.
    unread.value = false
    idle.check()
    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('is stopped once it has been detached 24 h, on one timer for every relay; fully read busy work is not', async () => {
    let now = 0
    const cap = new ProviderRelayDetachedCap(
      () => {},
      () => now
    )
    const unread = relay('unread', { tracking: true, unread: true })
    const unknown = relay('unknown', { tracking: false, unread: false })
    const busyRead = relay('busy-read', { tracking: true, unread: false })
    cap.detached(unread)
    now = 2 * HOUR
    cap.detached(unknown)
    cap.detached(busyRead)
    // Every deadline shares one timer, at the earliest.
    expect(vi.getTimerCount()).toBe(1)
    now = RELAY_DETACHED_CAP_MS - 1
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS - 1)
    expect(unread.close).not.toHaveBeenCalled()
    now = RELAY_DETACHED_CAP_MS
    await vi.advanceTimersByTimeAsync(1)
    expect([unread.stoppedBy, unread.close]).toEqual(['cap', unread.close])
    expect(unread.close).toHaveBeenCalledTimes(1)
    expect(unknown.close).not.toHaveBeenCalled()
    now = RELAY_DETACHED_CAP_MS + 2 * HOUR
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(unknown.stoppedBy).toBe('cap')
    expect(busyRead.close).not.toHaveBeenCalled()
    // Attached again before its deadline: never stopped.
    const back = relay('back', { tracking: true, unread: true })
    cap.detached(back)
    cap.forget(back)
    now += RELAY_DETACHED_CAP_MS * 2
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS * 2)
    expect(back.close).not.toHaveBeenCalled()
    expect(busyRead.close).not.toHaveBeenCalled()
    cap.stop()
  })

  it('reports a cap stop whose work had all ended as finished, so its chat gets no restart offer', async () => {
    let now = 0
    const cap = new ProviderRelayDetachedCap(
      () => {},
      () => now
    )
    const done = relay('done', { tracking: true, unread: true, finished: true })
    const working = relay('working', { tracking: true, unread: true })
    cap.detached(done)
    cap.detached(working)
    now = RELAY_DETACHED_CAP_MS
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS)
    expect(providerRelayStopFlags(done.stoppedBy)).toEqual({ idleStopped: true, capStopped: true })
    expect(providerRelayStopFlags(working.stoppedBy)).toEqual({ capStopped: true })
    cap.stop()
  })
})
