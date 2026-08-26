import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, rateLimitGuardMock, noteSpendMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  rateLimitGuardMock: vi.fn(),
  noteSpendMock: vi.fn()
}))

vi.mock('../../gh-utils', () => ({ ghExecFileAsync: ghExecFileAsyncMock }))
vi.mock('../../rate-limit', () => ({
  repositoryRateLimitGuard: rateLimitGuardMock,
  noteRepositoryRateLimitSpend: noteSpendMock
}))
vi.mock('../../github-api-repository', () => ({ githubHostExecOptions: () => ({}) }))

import { detectPullRequestMergeQueueEntry } from './pull-request-merge-queue-entry'

const ownerRepo = { owner: 'stablyai', repo: 'orca' }

function graphqlResponse(pullRequest: unknown): { stdout: string } {
  return { stdout: JSON.stringify({ data: { repository: { pullRequest } } }) }
}

describe('detectPullRequestMergeQueueEntry', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteSpendMock.mockReset()
  })

  it('returns the queue entry when the PR is in the merge queue', async () => {
    ghExecFileAsyncMock.mockResolvedValue(
      graphqlResponse({
        isInMergeQueue: true,
        mergeQueueEntry: {
          state: 'QUEUED',
          position: 3,
          estimatedTimeToMerge: 600,
          enqueuedAt: '2026-08-26T00:00:00Z'
        }
      })
    )
    await expect(detectPullRequestMergeQueueEntry(ownerRepo, 42, {})).resolves.toEqual({
      mergeQueueEntry: {
        state: 'QUEUED',
        position: 3,
        estimatedTimeToMerge: 600,
        enqueuedAt: '2026-08-26T00:00:00Z'
      }
    })
    expect(noteSpendMock).toHaveBeenCalledTimes(1)
  })

  it('nulls out non-numeric position and ETA rather than passing them through', async () => {
    ghExecFileAsyncMock.mockResolvedValue(
      graphqlResponse({
        isInMergeQueue: true,
        mergeQueueEntry: { state: 'AWAITING_CHECKS', position: null, estimatedTimeToMerge: null }
      })
    )
    await expect(detectPullRequestMergeQueueEntry(ownerRepo, 42, {})).resolves.toEqual({
      mergeQueueEntry: {
        state: 'AWAITING_CHECKS',
        position: null,
        estimatedTimeToMerge: null,
        enqueuedAt: null
      }
    })
  })

  it('synthesises an entry when GitHub reports membership without one', async () => {
    ghExecFileAsyncMock.mockResolvedValue(
      graphqlResponse({ isInMergeQueue: true, mergeQueueEntry: null })
    )
    await expect(detectPullRequestMergeQueueEntry(ownerRepo, 42, {})).resolves.toEqual({
      mergeQueueEntry: {
        state: 'QUEUED',
        position: null,
        estimatedTimeToMerge: null,
        enqueuedAt: null
      }
    })
  })

  it('reports not-queued when GitHub says the PR is not in the queue', async () => {
    ghExecFileAsyncMock.mockResolvedValue(
      graphqlResponse({ isInMergeQueue: false, mergeQueueEntry: null })
    )
    await expect(detectPullRequestMergeQueueEntry(ownerRepo, 42, {})).resolves.toEqual({})
  })

  it('degrades to not-queued when the probe throws', async () => {
    ghExecFileAsyncMock.mockRejectedValue(new Error('gh exploded'))
    await expect(detectPullRequestMergeQueueEntry(ownerRepo, 42, {})).resolves.toEqual({})
  })

  it('spends nothing when the rate-limit guard is blocked', async () => {
    rateLimitGuardMock.mockReturnValue({ blocked: true })
    await expect(detectPullRequestMergeQueueEntry(ownerRepo, 42, {})).resolves.toEqual({})
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(noteSpendMock).not.toHaveBeenCalled()
  })
})
