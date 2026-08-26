import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  ghExecFileAsyncMock,
  detectRepositoryMergeMetadataMock,
  detectPullRequestMergeQueueEntryMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  detectRepositoryMergeMetadataMock: vi.fn(),
  detectPullRequestMergeQueueEntryMock: vi.fn()
}))

vi.mock('../../gh-utils', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  classifyGhError: () => ({ type: 'unknown' }),
  ghRepoExecOptions: () => ({}),
  githubRepoContext: () => ({})
}))
vi.mock('../../github-api-repository', () => ({ githubHostExecOptions: () => ({}) }))
vi.mock('./../detect/repository-merge-metadata', () => ({
  detectRepositoryMergeMetadata: detectRepositoryMergeMetadataMock
}))
vi.mock('./../detect/pull-request-merge-queue-entry', () => ({
  detectPullRequestMergeQueueEntry: detectPullRequestMergeQueueEntryMock
}))

import { fetchPullRequestWorkItem } from './work-item-fetch'

const ownerRepo = { owner: 'stablyai', repo: 'orca' }
const mergeQueueEntry = { state: 'QUEUED', position: 2 }

function prViewPayload(overrides: Record<string, unknown> = {}): { stdout: string } {
  return {
    stdout: JSON.stringify({
      number: 7,
      title: 'A pull request',
      state: 'OPEN',
      url: 'https://github.com/stablyai/orca/pull/7',
      baseRefName: 'main',
      ...overrides
    })
  }
}

describe('fetchPullRequestWorkItem merge-queue probe', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    detectRepositoryMergeMetadataMock.mockReset()
    detectPullRequestMergeQueueEntryMock.mockReset()
    ghExecFileAsyncMock.mockResolvedValue(prViewPayload())
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: false,
      autoMergeAllowed: true
    })
    detectPullRequestMergeQueueEntryMock.mockResolvedValue({ mergeQueueEntry })
  })

  it('does not probe when the base branch does not require a merge queue', async () => {
    const item = await fetchPullRequestWorkItem('/repo', ownerRepo, 7)
    expect(detectPullRequestMergeQueueEntryMock).not.toHaveBeenCalled()
    expect(item?.mergeQueueEntry).toBeUndefined()
  })

  it('does not probe for a draft PR', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    ghExecFileAsyncMock.mockResolvedValue(prViewPayload({ isDraft: true }))
    await fetchPullRequestWorkItem('/repo', ownerRepo, 7)
    expect(detectPullRequestMergeQueueEntryMock).not.toHaveBeenCalled()
  })

  it('probes and publishes open + the entry when the base branch requires a queue', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    const item = await fetchPullRequestWorkItem('/repo', ownerRepo, 7)
    expect(detectPullRequestMergeQueueEntryMock).toHaveBeenCalledWith(ownerRepo, 7, {})
    // Why: `queued` is client-derived — the host publishes the wire value only.
    expect(item?.state).toBe('open')
    expect(item?.mergeQueueEntry).toEqual(mergeQueueEntry)
  })

  it('leaves the item unqueued when the probe degrades', async () => {
    detectRepositoryMergeMetadataMock.mockResolvedValue({
      mergeQueueRequired: true,
      autoMergeAllowed: true
    })
    detectPullRequestMergeQueueEntryMock.mockResolvedValue({})
    const item = await fetchPullRequestWorkItem('/repo', ownerRepo, 7)
    expect(item?.mergeQueueEntry).toBeUndefined()
  })
})
