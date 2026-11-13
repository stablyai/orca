import { afterEach, describe, expect, it } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { setPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import { makePR } from './pr-refresh-coordinator-test-harness'
import { prWatchNextDueAt } from './pr-refresh-watch-jobs'

const runningChecks: PRRefreshOutcome = {
  kind: 'found',
  pr: makePR({ checksStatus: 'pending' }),
  fetchedAt: 1_000
}

describe('CI-line watch cadence', () => {
  afterEach(() => {
    setPRAutoRefreshCadence('default')
  })

  it('reads running checks on the background interval by default', () => {
    expect(prWatchNextDueAt(runningChecks)).toBe(1_000 + 120_000)
  })

  it('follows a reduced host cadence', () => {
    setPRAutoRefreshCadence('reduced')
    expect(prWatchNextDueAt(runningChecks)).toBe(1_000 + 10 * 60_000)
  })

  it('slows instead of ending when auto-refresh is off, so the chat still gets its result', () => {
    setPRAutoRefreshCadence('off')
    expect(prWatchNextDueAt(runningChecks)).toBe(1_000 + 20 * 60_000)
  })
})
