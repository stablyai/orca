import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayIdleStop } from '../provider-relay-idle-stop'
import { readProviderRelayDetachPolicy } from '../provider-relay-detach-policy'
import {
  providerRelayStopFlags,
  ProviderRelayDetachedCap,
  RELAY_DETACHED_CAP_MS,
  RELAY_UNCLAIMED_MS,
  type CappableRelay
} from '../provider-relay-detached-cap'
import { CODEX_RELAY_WORK_MARKERS } from '../../../codex/app-server/codex-app-server-relay'

const IDLE_MS = 30 * 60_000
const HOUR = 60 * 60_000

function relay(
  id: string,
  state: { tracking: boolean; unread: boolean; finished?: boolean; onlyWaiting?: boolean }
): CappableRelay {
  return {
    relayId: id,
    live: true,
    attachedClientId: null,
    idleStopPolicy: { finished: false, unaccounted: false, onlyWaiting: false, ...state },
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

  it('caps an agent whose turn is only waiting on an approval, never one running a command or an unblocked turn', async () => {
    const approvals = { count: 1, items: new Set(['cmd-asked']) }
    const counted = vi.fn()
    const detachWith = (open: Record<string, string[][]>, idleStopMs: number | null = IDLE_MS) => {
      const idle = new ProviderRelayIdleStop({
        attached: () => false,
        live: () => true,
        pendingCount: () => approvals.count,
        askingCount: () => approvals.count,
        awaitingStart: (itemId) => approvals.items.has(itemId),
        unacked: () => [],
        stop: vi.fn(),
        idleUnread: counted
      })
      idle.arm(
        readProviderRelayDetachPolicy({
          idleStopMs,
          markers: CODEX_RELAY_WORK_MARKERS.markers,
          open
        })
      )
      return idle
    }
    // A Codex turn blocked on an approval (a normal quit with one pending) is waiting, not busy.
    const blocked = detachWith({ turn: [['thread-1']] })
    expect(blocked.onlyWaiting).toBe(true)
    await vi.advanceTimersByTimeAsync(IDLE_MS)
    expect(counted).toHaveBeenCalledTimes(1)
    // Codex opens a command item before asking to run it: that one is waiting too.
    expect(
      detachWith({ turn: [['thread-1']], command: [['thread-1', 'cmd-asked']] }).onlyWaiting
    ).toBe(true)
    // A command still running is busy, approval or not.
    expect(detachWith({ turn: [['thread-1']], command: [['thread-1', 'cmd-1']] }).onlyWaiting).toBe(
      false
    )
    // Left only waiting after the detach, with the idle stop off: the agent's line counts it.
    approvals.count = 0
    const later = detachWith({ turn: [['thread-1']] }, null)
    counted.mockClear()
    approvals.count = 1
    later.observeAgentLine('{"method":"item/commandExecution/requestApproval","id":7}')
    expect(counted).toHaveBeenCalledTimes(1)
    // A turn with no approval waiting is running.
    approvals.count = 0
    expect(blocked.onlyWaiting).toBe(false)
    let now = 0
    const cap = new ProviderRelayDetachedCap(
      () => {},
      () => now
    )
    const asking = relay('asking', { tracking: true, unread: false, onlyWaiting: true })
    const turning = relay('turning', { tracking: true, unread: false })
    for (const each of [asking, turning]) {
      cap.detached(each)
      cap.idleUnread(each)
    }
    now = RELAY_DETACHED_CAP_MS
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS)
    expect(asking.stoppedBy).toBe('cap')
    expect(turning.close).not.toHaveBeenCalled()
    cap.stop()
  })

  it('is stopped 24 h after its detach once idle with unread output or with work unknown, on one timer; busy work never', async () => {
    let now = 0
    const cap = new ProviderRelayDetachedCap(
      () => {},
      () => now
    )
    const unread = relay('unread', { tracking: true, unread: true, finished: true })
    const unknown = relay('unknown', { tracking: false, unread: false })
    const busyRead = relay('busy-read', { tracking: true, unread: false })
    const busyAgain = relay('busy-again', { tracking: true, unread: true, finished: true })
    cap.detached(unread)
    cap.detached(busyRead)
    cap.detached(busyAgain)
    // Busy relays count for nothing: no timer at all.
    expect(vi.getTimerCount()).toBe(0)
    cap.idleUnread(unread)
    cap.idleUnread(busyAgain)
    now = 2 * HOUR
    cap.detached(unknown)
    // Every deadline shares one timer, at the earliest.
    expect(vi.getTimerCount()).toBe(1)
    Object.assign(busyAgain.idleStopPolicy, { finished: false })
    now = RELAY_DETACHED_CAP_MS - 1
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS - 1)
    expect(unread.close).not.toHaveBeenCalled()
    now = RELAY_DETACHED_CAP_MS
    await vi.advanceTimersByTimeAsync(1)
    expect(unread.stoppedBy).toBe('cap-finished')
    expect(unread.close).toHaveBeenCalledTimes(1)
    expect(busyAgain.close).not.toHaveBeenCalled()
    expect(unknown.close).not.toHaveBeenCalled()
    now = RELAY_DETACHED_CAP_MS + 2 * HOUR
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(unknown.stoppedBy).toBe('cap')
    // Nothing counted is left: no recheck wakes the daemon for busy work.
    expect(vi.getTimerCount()).toBe(0)
    expect(busyRead.close).not.toHaveBeenCalled()
    expect(busyAgain.close).not.toHaveBeenCalled()
    // Attached again before its deadline: never stopped.
    const back = relay('back', { tracking: false, unread: true })
    cap.detached(back)
    cap.forget(back)
    now += RELAY_DETACHED_CAP_MS * 2
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS * 2)
    expect(back.close).not.toHaveBeenCalled()
    cap.stop()
  })

  it('reports a cap stop whose work had all ended as finished, so its chat gets no restart offer', async () => {
    let now = 0
    const cap = new ProviderRelayDetachedCap(
      () => {},
      () => now
    )
    const done = relay('done', { tracking: true, unread: true, finished: true })
    const working = relay('working', { tracking: false, unread: true })
    cap.detached(done)
    cap.idleUnread(done)
    cap.detached(working)
    now = RELAY_DETACHED_CAP_MS
    await vi.advanceTimersByTimeAsync(RELAY_DETACHED_CAP_MS)
    expect(providerRelayStopFlags(done.stoppedBy)).toEqual({ idleStopped: true, capStopped: true })
    expect(providerRelayStopFlags(working.stoppedBy)).toEqual({ capStopped: true })
    cap.stop()
  })

  it('ends a spawned agent no app attached soon after, its spawn reply lost', async () => {
    let now = 0
    const cap = new ProviderRelayDetachedCap(
      () => {},
      () => now
    )
    const lost = relay('lost', { tracking: false, unread: false })
    const claimed = relay('claimed', { tracking: false, unread: false })
    cap.spawned(lost)
    cap.spawned(claimed)
    cap.forget(claimed)
    now = RELAY_UNCLAIMED_MS
    await vi.advanceTimersByTimeAsync(RELAY_UNCLAIMED_MS)
    expect(lost.close).toHaveBeenCalledTimes(1)
    expect(claimed.close).not.toHaveBeenCalled()
    cap.stop()
  })
})
