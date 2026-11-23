import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderRelayIdleStop } from '../provider-relay-idle-stop'

const IDLE_MS = 30 * 60_000
const policy = (working: boolean) => ({
  idleStopMs: IDLE_MS,
  working,
  workStarts: ['turn/started'],
  workEnds: ['turn/completed']
})

function rig(children: boolean | null = false) {
  const state = { attached: false, pending: 0, children }
  const stop = vi.fn()
  const idle = new ProviderRelayIdleStop({
    pid: () => 4242,
    attached: () => state.attached,
    live: () => true,
    pendingCount: () => state.pending,
    stop,
    hasChildren: async () => state.children
  })
  return { idle, state, stop }
}

describe('provider relay idle stop', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('never stops a detached agent that is working, owed an answer, or has child processes', async () => {
    const working = rig()
    working.idle.arm(policy(true))
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(working.stop).not.toHaveBeenCalled()
    working.idle.observeAgentLine('{"method":"turn/completed","params":{}}')
    await vi.advanceTimersByTimeAsync(IDLE_MS + 120_000)
    expect(working.stop).toHaveBeenCalledTimes(1)

    const owed = rig()
    owed.state.pending = 1
    owed.idle.arm(policy(false))
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(owed.stop).not.toHaveBeenCalled()

    for (const children of [true, null]) {
      const busy = rig(children)
      busy.idle.arm(policy(false))
      await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
      expect(busy.stop).not.toHaveBeenCalled()
    }
  })

  it('stops a quiet idle agent after the window, and an attach in time keeps it', async () => {
    const quiet = rig()
    quiet.idle.arm(policy(false))
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1_000)
    expect(quiet.stop).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(quiet.stop).toHaveBeenCalledTimes(1)

    const kept = rig()
    kept.idle.arm(policy(false))
    await vi.advanceTimersByTimeAsync(IDLE_MS / 2)
    kept.idle.disarm()
    await vi.advanceTimersByTimeAsync(3 * IDLE_MS)
    expect(kept.stop).not.toHaveBeenCalled()
  })
})
