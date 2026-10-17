import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LegacyDaemonDrainRetirement } from './daemon-legacy-drain-retirement'
import type { DaemonPtyAdapter } from './daemon-pty-adapter'

vi.mock('./daemon-lifecycle-event', () => ({ trackDaemonRetired: vi.fn() }))

import { trackDaemonRetired } from './daemon-lifecycle-event'

const DEBOUNCE_MS = 5_000

function createHarness(
  opts: {
    isLegacy?: boolean
    ownsRoutedSession?: boolean
    retirementResult?:
      | { state: 'retiring' }
      | { state: 'busy'; liveSessions: number | null }
      | { state: 'unsupported' }
      | { state: 'unverifiable' }
    retirementError?: Error
  } = {}
) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scheduler only reads adapter identity; the harness deps carry all behavior.
  const adapter = { label: 'legacy' } as unknown as DaemonPtyAdapter
  const deps = {
    isLegacyAdapter: vi.fn(() => opts.isLegacy ?? true),
    ownsRoutedSession: vi.fn(() => opts.ownsRoutedSession ?? false),
    requestIdleRetirement: vi.fn(async () => {
      if (opts.retirementError) {
        throw opts.retirementError
      }
      return opts.retirementResult ?? { state: 'retiring' as const }
    }),
    detachAdapter: vi.fn(),
    debounceMs: DEBOUNCE_MS
  }
  const scheduler = new LegacyDaemonDrainRetirement(deps)
  return { adapter, deps, scheduler }
}

describe('LegacyDaemonDrainRetirement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('retires a drained legacy adapter after the debounce settles', async () => {
    const { adapter, deps, scheduler } = createHarness()

    scheduler.scheduleDrainCheck(adapter)
    expect(deps.requestIdleRetirement).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(deps.requestIdleRetirement).toHaveBeenCalledWith(adapter)
    expect(deps.detachAdapter).toHaveBeenCalledWith(adapter)
    expect(trackDaemonRetired).toHaveBeenCalledWith('drained_legacy')
  })

  it('ignores the current generation entirely', async () => {
    const { adapter, deps, scheduler } = createHarness({ isLegacy: false })

    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)

    expect(deps.requestIdleRetirement).not.toHaveBeenCalled()
    expect(deps.detachAdapter).not.toHaveBeenCalled()
  })

  it('skips the RPC when the adapter still owns a routed session', async () => {
    const { adapter, deps, scheduler } = createHarness({ ownsRoutedSession: true })

    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)

    expect(deps.requestIdleRetirement).not.toHaveBeenCalled()
    expect(deps.detachAdapter).not.toHaveBeenCalled()
  })

  it('coalesces exit bursts into one census', async () => {
    const { adapter, deps, scheduler } = createHarness()

    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100)
    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS - 100)
    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(deps.requestIdleRetirement).toHaveBeenCalledTimes(1)
  })

  it('stays attached when the daemon refuses because it is busy', async () => {
    const { adapter, deps, scheduler } = createHarness({
      retirementResult: { state: 'busy', liveSessions: 2 }
    })

    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

    expect(deps.detachAdapter).not.toHaveBeenCalled()
    expect(trackDaemonRetired).not.toHaveBeenCalled()

    // Why: a later drain signal must retry after the sessions that blocked it exit.
    scheduler.scheduleDrainCheck(adapter)
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)
    expect(deps.requestIdleRetirement).toHaveBeenCalledTimes(2)
  })

  it('stays attached on unsupported and unverifiable verdicts', async () => {
    for (const state of ['unsupported', 'unverifiable'] as const) {
      const { adapter, deps, scheduler } = createHarness({ retirementResult: { state } })

      scheduler.scheduleDrainCheck(adapter)
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      expect(deps.detachAdapter).not.toHaveBeenCalled()
    }
  })

  it('never surfaces a retirement failure to the event callback', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const { adapter, deps, scheduler } = createHarness({
        retirementError: new Error('rpc died')
      })

      scheduler.scheduleDrainCheck(adapter)
      await vi.advanceTimersByTimeAsync(DEBOUNCE_MS)

      expect(deps.detachAdapter).not.toHaveBeenCalled()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('sweeps drained adapters immediately at startup and skips routed ones', async () => {
    const drained = createHarness()
    const routed = createHarness({ ownsRoutedSession: true })
    const scheduler = drained.scheduler

    scheduler.sweepDrainedLegacyAdapters([drained.adapter, routed.adapter])

    await vi.waitFor(() => {
      expect(drained.deps.requestIdleRetirement).toHaveBeenCalledWith(drained.adapter)
    })
    expect(routed.deps.requestIdleRetirement).not.toHaveBeenCalled()
    expect(drained.deps.detachAdapter).toHaveBeenCalled()
  })

  it('dispose cancels pending drain checks', async () => {
    const { adapter, deps, scheduler } = createHarness()

    scheduler.scheduleDrainCheck(adapter)
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS * 2)

    expect(deps.requestIdleRetirement).not.toHaveBeenCalled()
  })
})
