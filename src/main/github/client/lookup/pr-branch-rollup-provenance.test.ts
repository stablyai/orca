import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PullRequestLookupData } from './pull-request-lookup-data'

const { ghExecFileAsyncMock, getPRByNumberMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getPRByNumberMock: vi.fn()
}))

vi.mock('../../gh-utils', () => ({ ghExecFileAsync: ghExecFileAsyncMock }))
vi.mock('./pr-number-lookup', () => ({ getPRByNumber: getPRByNumberMock }))

import { getFallbackPRListForBranch, hydrateBranchLookupWithExactPR } from './pr-branch-lookup'
import { assemblePRRefreshFoundOutcome } from './pr-refresh-outcome-assembly'

const cancelledRollup = [{ status: 'COMPLETED', conclusion: 'CANCELLED' }]

function lookupData(
  statusCheckRollup: unknown[],
  statusCheckRollupComplete?: boolean
): PullRequestLookupData {
  return {
    number: 42,
    title: 'Cancellation provenance',
    state: 'OPEN',
    url: 'https://github.com/acme/widgets/pull/42',
    statusCheckRollup,
    ...(statusCheckRollupComplete !== undefined ? { statusCheckRollupComplete } : {}),
    updatedAt: '2026-08-22T00:00:00Z',
    mergeable: 'MERGEABLE'
  }
}

function assembledPR(data: PullRequestLookupData) {
  const outcome = assemblePRRefreshFoundOutcome({
    data,
    dataRepo: null,
    dataHeadRepo: null,
    stack: undefined,
    mergeable: 'MERGEABLE',
    stackMergeQueueRequired: undefined,
    confirmedContainedHeadOid: null,
    headDivergedFromMergedPRAtOid: null,
    conflictSummary: undefined
  })
  if (outcome.kind !== 'found') {
    throw new Error('expected found outcome')
  }
  return outcome.pr
}

describe('branch rollup provenance', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getPRByNumberMock.mockReset()
  })

  it('keeps partial list cancellation coarse when exact hydration fails', async () => {
    ghExecFileAsyncMock.mockResolvedValue({
      stdout: JSON.stringify([lookupData(cancelledRollup)])
    })
    const listed = await getFallbackPRListForBranch(
      { owner: 'acme', repo: 'widgets' },
      'feature/test',
      { cwd: '/repo' }
    )
    getPRByNumberMock.mockRejectedValue(new Error('transient view failure'))

    const hydrated = await hydrateBranchLookupWithExactPR(
      { owner: 'acme', repo: 'widgets' },
      listed,
      { cwd: '/repo' },
      'local:host'
    )
    const pr = assembledPR(hydrated!)
    expect(hydrated?.statusCheckRollupComplete).toBe(false)
    expect(pr.checksStatus).toBe('failure')
    expect(pr.checksPresentationStatus).toBeUndefined()
  })

  it('presents exact complete cancellation as cancelled', async () => {
    const exact = lookupData(cancelledRollup, true)
    getPRByNumberMock.mockResolvedValue(exact)

    const hydrated = await hydrateBranchLookupWithExactPR(
      { owner: 'acme', repo: 'widgets' },
      lookupData(cancelledRollup, false),
      { cwd: '/repo' },
      'local:host'
    )

    expect(assembledPR(hydrated!).checksPresentationStatus).toBe('cancelled')
  })

  it('keeps genuine failure unchanged for a complete rollup', () => {
    const pr = assembledPR(
      lookupData([...cancelledRollup, { status: 'COMPLETED', conclusion: 'FAILURE' }], true)
    )
    expect(pr.checksStatus).toBe('failure')
    expect(pr.checksPresentationStatus).toBeUndefined()
  })
})
