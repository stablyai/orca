import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WEDGED_SESSION_RECONCILE_INTERVAL_MS,
  WedgedSessionReconciler
} from './wedged-session-reconciler'
import type { Session } from './session'

/** Minimal Session stub exposing only `reconcileWedgedExit`, plus the spy so tests can count sweeps. */
function fakeSession() {
  const reconcile = vi.fn()
  return { session: { reconcileWedgedExit: reconcile } as unknown as Session, reconcile }
}

describe('WedgedSessionReconciler', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sweeps every session on each interval and stops on stop()', () => {
    const a = fakeSession()
    const b = fakeSession()
    const sessions = new Map<string, Session>([
      ['a', a.session],
      ['b', b.session]
    ])
    const reconciler = new WedgedSessionReconciler()

    reconciler.start(sessions)
    vi.advanceTimersByTime(WEDGED_SESSION_RECONCILE_INTERVAL_MS)
    expect(a.reconcile).toHaveBeenCalledTimes(1)
    expect(b.reconcile).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(WEDGED_SESSION_RECONCILE_INTERVAL_MS)
    expect(a.reconcile).toHaveBeenCalledTimes(2)

    reconciler.stop()
    vi.advanceTimersByTime(WEDGED_SESSION_RECONCILE_INTERVAL_MS * 3)
    expect(a.reconcile).toHaveBeenCalledTimes(2) // no further sweeps after stop()
  })

  it('start() is idempotent — a second call does not double the sweep rate', () => {
    const a = fakeSession()
    const sessions = new Map<string, Session>([['a', a.session]])
    const reconciler = new WedgedSessionReconciler()

    reconciler.start(sessions)
    reconciler.start(sessions)
    vi.advanceTimersByTime(WEDGED_SESSION_RECONCILE_INTERVAL_MS)
    expect(a.reconcile).toHaveBeenCalledTimes(1)

    reconciler.stop()
  })
})
