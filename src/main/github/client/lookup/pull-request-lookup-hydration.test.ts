import { beforeEach, describe, expect, it, vi } from 'vitest'

const { detectRepositoryMergeMetadataMock, detectPullRequestMergeQueueEntryMock } = vi.hoisted(
  () => ({
    detectRepositoryMergeMetadataMock: vi.fn(),
    detectPullRequestMergeQueueEntryMock: vi.fn()
  })
)

vi.mock('./../detect/repository-merge-metadata', () => ({
  detectRepositoryMergeMetadata: detectRepositoryMergeMetadataMock
}))
vi.mock('./../detect/pull-request-merge-queue-entry', () => ({
  detectPullRequestMergeQueueEntry: detectPullRequestMergeQueueEntryMock
}))

import { hydratePullRequestLookupData } from './pull-request-lookup-hydration'
import type { PullRequestLookupData } from './pull-request-lookup-data'

const ownerRepo = { owner: 'stablyai', repo: 'orca' }

function lookupData(overrides: Partial<PullRequestLookupData> = {}): PullRequestLookupData {
  return {
    number: 42,
    title: 'A pull request',
    state: 'OPEN',
    url: 'https://github.com/stablyai/orca/pull/42',
    statusCheckRollup: [],
    updatedAt: '2026-08-26T00:00:00Z',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    ...overrides
  }
}

describe('hydratePullRequestLookupData merge-queue probe gating', () => {
  beforeEach(() => {
    detectRepositoryMergeMetadataMock.mockReset()
    detectPullRequestMergeQueueEntryMock.mockReset()
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: false,
      autoMergeAllowed: true
    })
    detectPullRequestMergeQueueEntryMock.mockResolvedValue({})
  })

  it('does not probe when the base branch does not require a merge queue', async () => {
    const hydrated = await hydratePullRequestLookupData(ownerRepo, lookupData(), {}, 'default')
    expect(detectPullRequestMergeQueueEntryMock).not.toHaveBeenCalled()
    expect(hydrated.mergeQueueEntry).toBeUndefined()
  })

  it('does not probe for a draft PR', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    await hydratePullRequestLookupData(ownerRepo, lookupData({ isDraft: true }), {}, 'default')
    expect(detectPullRequestMergeQueueEntryMock).not.toHaveBeenCalled()
  })

  it('does not probe for a merged PR', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    await hydratePullRequestLookupData(ownerRepo, lookupData({ state: 'MERGED' }), {}, 'default')
    expect(detectPullRequestMergeQueueEntryMock).not.toHaveBeenCalled()
  })

  it('probes and carries the queue entry when the base branch requires a merge queue', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    detectPullRequestMergeQueueEntryMock.mockResolvedValue({
      mergeQueueEntry: { state: 'QUEUED', position: 2, estimatedTimeToMerge: 900, enqueuedAt: null }
    })
    const hydrated = await hydratePullRequestLookupData(ownerRepo, lookupData(), {}, 'default')
    expect(detectPullRequestMergeQueueEntryMock).toHaveBeenCalledWith(ownerRepo, 42, {})
    expect(hydrated.mergeQueueEntry).toEqual({
      state: 'QUEUED',
      position: 2,
      estimatedTimeToMerge: 900,
      enqueuedAt: null
    })
  })

  it('leaves the PR unqueued when the probe degrades', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    const hydrated = await hydratePullRequestLookupData(ownerRepo, lookupData(), {}, 'default')
    expect(hydrated.mergeQueueEntry).toBeUndefined()
  })
})
