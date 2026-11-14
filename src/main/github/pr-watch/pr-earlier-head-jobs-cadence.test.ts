import { afterEach, expect, it, vi } from 'vitest'
import { setPRAutoRefreshCadence } from '../../../shared/review-refresh-policy'

const mocks = vi.hoisted(() => ({
  read: vi.fn(async () => []),
  pending: vi.fn(() => [{ headSha: 'old-head', movedAt: 1, expiresAt: null }])
}))
vi.mock('../pull-requests/refresh/pr-refresh-coordinator', () => ({ schedulePRWatchRead: vi.fn() }))
vi.mock('./pr-check-event-tables', () => ({
  readPRPendingHeads: mocks.pending,
  deletePRPendingHead: vi.fn()
}))
vi.mock('./pr-head-check-read', () => ({ readPRHeadCheckRollup: mocks.read }))

import { PREarlierHeadJobs } from './pr-earlier-head-jobs'
import { prWatchPlanDueAt } from '../pull-requests/refresh/pr-refresh-watch-jobs'

afterEach(() => setPRAutoRefreshCadence('default'))

it.each([
  ['default', 120_000],
  ['reduced', 10 * 60_000],
  ['minimal', 20 * 60_000],
  // A chat is waiting for the result, so off slows to minimal instead of stopping.
  ['off', 20 * 60_000]
] as const)(
  'an earlier head’s next read follows the %s watch cadence',
  async (cadence, interval) => {
    setPRAutoRefreshCadence(cadence)
    const jobs = new PREarlierHeadJobs({
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the table reads are mocked above, so the database handle is never dereferenced.
      database: { db: {} } as never,
      apply: () => false,
      logger: { warn: vi.fn() },
      now: () => 1_000
    })
    const readAt = await jobs.read(
      { prKey: 'github.com/acme/repo#7', headSha: 'old-head' },
      { repoId: 'r', repoPath: '/repo', branch: 'topic', repoKind: 'git', cacheKey: 'k' }
    )
    expect(readAt).toBe(1_000)
    expect(prWatchPlanDueAt({ kind: 'head', at: readAt! })).toBe(1_000 + interval)
  }
)
