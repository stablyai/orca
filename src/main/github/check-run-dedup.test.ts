import { describe, it, expect } from 'vitest'
import type { PRCheckDetail } from '../../shared/types'
import { latestRollupEntriesByName, latestCheckDetailsByName } from './check-run-dedup'

describe('latestRollupEntriesByName', () => {
  it('keeps the latest run per name, dropping a superseded CANCELLED', () => {
    const rollup = [
      {
        name: 'check-pr-description',
        conclusion: 'CANCELLED',
        completedAt: '2026-07-20T08:54:00Z'
      },
      { name: 'check-pr-description', conclusion: 'SUCCESS', completedAt: '2026-07-20T09:02:00Z' }
    ]
    const latest = latestRollupEntriesByName(rollup)
    expect(latest).toHaveLength(1)
    expect(latest[0]).toMatchObject({ conclusion: 'SUCCESS' })
  })

  it('falls back to startedAt when completedAt is absent', () => {
    const rollup = [
      { name: 'build', conclusion: 'FAILURE', completedAt: '2026-07-20T08:54:00Z' },
      { name: 'build', status: 'IN_PROGRESS', startedAt: '2026-07-20T09:00:00Z' }
    ]
    const latest = latestRollupEntriesByName(rollup) as { status?: string }[]
    expect(latest).toHaveLength(1)
    expect(latest[0].status).toBe('IN_PROGRESS')
  })

  it('scopes dedup by workflow so same-named jobs in different workflows stay separate', () => {
    const rollup = [
      {
        name: 'test',
        workflowName: 'CI',
        conclusion: 'SUCCESS',
        completedAt: '2026-07-20T09:00:00Z'
      },
      {
        name: 'test',
        workflowName: 'Nightly',
        conclusion: 'FAILURE',
        completedAt: '2026-07-20T09:00:00Z'
      }
    ]
    expect(latestRollupEntriesByName(rollup)).toHaveLength(2)
  })

  it('collapses statusCheckRollup to success once every context has a fresh green run', () => {
    const rollup = [
      {
        name: 'check-pr-description',
        conclusion: 'CANCELLED',
        completedAt: '2026-07-20T08:54:00Z'
      },
      { name: 'misc-checks', conclusion: 'CANCELLED', completedAt: '2026-07-20T08:54:00Z' },
      { name: 'wait-for-pr-checks', conclusion: 'FAILURE', completedAt: '2026-07-20T08:55:00Z' },
      { name: 'check-pr-description', conclusion: 'SUCCESS', completedAt: '2026-07-20T09:02:00Z' },
      { name: 'misc-checks', conclusion: 'SUCCESS', completedAt: '2026-07-20T08:56:00Z' },
      { name: 'wait-for-pr-checks', conclusion: 'SUCCESS', completedAt: '2026-07-20T08:57:00Z' }
    ]
    const latest = latestRollupEntriesByName(rollup) as { conclusion: string }[]
    expect(latest).toHaveLength(3)
    expect(latest.every((c) => c.conclusion === 'SUCCESS')).toBe(true)
  })

  it('keeps entries without a resolvable name', () => {
    const rollup = [{ conclusion: 'SUCCESS' }, null, 'weird']
    expect(latestRollupEntriesByName(rollup)).toHaveLength(3)
  })

  it('drops a cancelled matrix skeleton whose name kept an unexpanded ${{ }} expression', () => {
    const rollup = [
      {
        name: 'tests / test ${{ matrix.group }} (${{ matrix.index }})',
        conclusion: 'CANCELLED',
        completedAt: '2026-07-20T10:29:00Z'
      },
      {
        name: 'tests / test backend (1/4)',
        conclusion: 'SUCCESS',
        completedAt: '2026-07-20T11:00:00Z'
      }
    ]
    const latest = latestRollupEntriesByName(rollup) as { conclusion: string }[]
    expect(latest).toHaveLength(1)
    expect(latest[0].conclusion).toBe('SUCCESS')
  })
})

describe('latestCheckDetailsByName', () => {
  const detail = (over: Partial<PRCheckDetail>): PRCheckDetail => ({
    name: 'check',
    status: 'completed',
    conclusion: 'success',
    url: null,
    ...over
  })

  it('keeps the run with the highest checkRunId per name', () => {
    const checks = [
      detail({ name: 'check-pr-description', conclusion: 'cancelled', checkRunId: 100 }),
      detail({ name: 'check-pr-description', conclusion: 'success', checkRunId: 200 })
    ]
    const latest = latestCheckDetailsByName(checks)
    expect(latest).toHaveLength(1)
    expect(latest[0]).toMatchObject({ conclusion: 'success', checkRunId: 200 })
  })

  it('preserves first-seen order of distinct names', () => {
    const checks = [
      detail({ name: 'a', checkRunId: 1 }),
      detail({ name: 'b', checkRunId: 2 }),
      detail({ name: 'a', checkRunId: 3 })
    ]
    expect(latestCheckDetailsByName(checks).map((c) => c.name)).toEqual(['a', 'b'])
  })

  it('keeps rows lacking a checkRunId', () => {
    const checks = [detail({ name: 'legacy-status', conclusion: 'failure' })]
    expect(latestCheckDetailsByName(checks)).toHaveLength(1)
  })

  it('drops an unexpanded matrix skeleton row', () => {
    const checks = [
      detail({ name: 'test ${{ matrix.group }}', conclusion: 'cancelled', checkRunId: 1 }),
      detail({ name: 'test backend', conclusion: 'success', checkRunId: 2 })
    ]
    const latest = latestCheckDetailsByName(checks)
    expect(latest.map((c) => c.name)).toEqual(['test backend'])
  })
})
