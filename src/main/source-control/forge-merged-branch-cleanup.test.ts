import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostedReviewInfo } from '../../shared/hosted-review'

const { getHostedReviewForBranchMock, getMergeRequestVersionHeadShasMock } = vi.hoisted(() => ({
  getHostedReviewForBranchMock: vi.fn(),
  getMergeRequestVersionHeadShasMock: vi.fn()
}))

vi.mock('./hosted-review', () => ({ getHostedReviewForBranch: getHostedReviewForBranchMock }))
vi.mock('../gitlab/merge-request-versions', () => ({
  getMergeRequestVersionHeadShas: getMergeRequestVersionHeadShasMock
}))

import {
  _resetUnansweredReviewHostsForTests,
  FORGE_MERGED_LOOKUP_TIMEOUT_MS,
  FORGE_UNANSWERED_WINDOW_MS,
  forgeMergedAtHeadCheck,
  settlePreservedBranchWithForge
} from './forge-merged-branch-cleanup'

const HEAD = '1111111111111111111111111111111111111111'
const LATER_HEAD = '2222222222222222222222222222222222222222'
const repo = {
  id: 'repo-1',
  path: '/repo',
  connectionId: null,
  executionHostId: undefined,
  ghAccount: undefined
}
const kept = { preservedBranch: { branchName: 'feature/test', head: HEAD } }

function review(overrides: Partial<HostedReviewInfo>): HostedReviewInfo {
  return {
    provider: 'github',
    number: 7,
    title: 'Fix',
    state: 'merged',
    url: 'https://example.test/7',
    status: 'success',
    updatedAt: '',
    mergeable: 'UNKNOWN',
    headSha: HEAD,
    ...overrides
  }
}

function confirmFor(linkedReviews?: { linkedPR: number | null; linkedGitLabMR?: number | null }) {
  return forgeMergedAtHeadCheck({ repo, localGitOptions: {}, linkedReviews })
}

beforeEach(() => {
  _resetUnansweredReviewHostsForTests()
  getHostedReviewForBranchMock.mockReset()
  getMergeRequestVersionHeadShasMock.mockReset()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('forgeMergedAtHeadCheck', () => {
  it('confirms a merged review whose head is the branch head', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(review({}))

    await expect(confirmFor({ linkedPR: 7 })('feature/test', HEAD)).resolves.toBe(true)
    expect(getHostedReviewForBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        repoPath: '/repo',
        executionHostId: 'local',
        branch: 'feature/test',
        linkedGitHubPR: 7,
        currentHeadOid: HEAD
      })
    )
  })

  it.each([
    ['open', review({ state: 'open' })],
    ['closed', review({ state: 'closed' })],
    ['no review', null]
  ])('refuses a %s review', async (_label, found) => {
    getHostedReviewForBranchMock.mockResolvedValue(found)

    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(false)
  })

  it('refuses a merged review whose head is a different commit', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(review({ headSha: LATER_HEAD }))

    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(false)
    expect(getMergeRequestVersionHeadShasMock).not.toHaveBeenCalled()
  })

  it('confirms a GitHub head the lookup proved is one of the merged PR commits', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(
      review({ headSha: LATER_HEAD, confirmedContainedHeadOid: HEAD })
    )

    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(true)
  })

  it('confirms a GitLab head that was one of the merge request versions', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(
      review({ provider: 'gitlab', number: 12, headSha: LATER_HEAD })
    )
    getMergeRequestVersionHeadShasMock.mockResolvedValue([LATER_HEAD, HEAD])

    await expect(
      confirmFor({ linkedPR: null, linkedGitLabMR: 12 })('feature/test', HEAD)
    ).resolves.toBe(true)
    expect(getMergeRequestVersionHeadShasMock).toHaveBeenCalledWith('/repo', 12, null, {
      localGitExecOptions: {}
    })
  })

  it('refuses a GitLab head no merge request version had', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(
      review({ provider: 'gitlab', number: 12, headSha: LATER_HEAD })
    )
    getMergeRequestVersionHeadShasMock.mockResolvedValue([LATER_HEAD])

    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(false)
  })

  it('matches an abbreviated Bitbucket head of at least 12 characters', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(
      review({ provider: 'bitbucket', headSha: HEAD.slice(0, 12) })
    )
    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(true)

    getHostedReviewForBranchMock.mockResolvedValue(
      review({ provider: 'bitbucket', headSha: HEAD.slice(0, 11) })
    )
    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(false)
  })

  it('does not prefix-match heads from other providers', async () => {
    getHostedReviewForBranchMock.mockResolvedValue(review({ headSha: HEAD.slice(0, 12) }))

    await expect(confirmFor()('feature/test', HEAD)).resolves.toBe(false)
  })
})

describe('settlePreservedBranchWithForge', () => {
  it('deletes the kept branch at its head when the forge confirms it merged', async () => {
    const deleteAtHead = vi.fn().mockResolvedValue(undefined)
    const confirmMergedAtHead = vi.fn().mockResolvedValue(true)

    await expect(
      settlePreservedBranchWithForge(
        { ...kept, removing: true },
        { reviewHostKey: 'repo', confirmMergedAtHead, deleteAtHead }
      )
    ).resolves.toEqual({ removing: true })
    expect(confirmMergedAtHead).toHaveBeenCalledWith('feature/test', HEAD)
    expect(deleteAtHead).toHaveBeenCalledWith('feature/test', HEAD)
  })

  it('keeps the branch when the forge does not confirm it', async () => {
    const deleteAtHead = vi.fn()

    await expect(
      settlePreservedBranchWithForge(kept, {
        reviewHostKey: 'repo',
        confirmMergedAtHead: vi.fn().mockResolvedValue(false),
        deleteAtHead
      })
    ).resolves.toBe(kept)
    expect(deleteAtHead).not.toHaveBeenCalled()
  })

  it('keeps the branch when the forge lookup fails', async () => {
    const deleteAtHead = vi.fn()

    await expect(
      settlePreservedBranchWithForge(kept, {
        reviewHostKey: 'repo',
        confirmMergedAtHead: vi.fn().mockRejectedValue(new Error('rate_limited')),
        deleteAtHead
      })
    ).resolves.toBe(kept)
    expect(deleteAtHead).not.toHaveBeenCalled()
  })

  it('keeps the branch when the forge does not answer within the cap', async () => {
    vi.useFakeTimers()
    const deleteAtHead = vi.fn()
    const settled = settlePreservedBranchWithForge(kept, {
      reviewHostKey: 'repo',
      confirmMergedAtHead: () => new Promise<boolean>(() => {}),
      deleteAtHead
    })

    await vi.advanceTimersByTimeAsync(FORGE_MERGED_LOOKUP_TIMEOUT_MS)

    await expect(settled).resolves.toBe(kept)
    expect(deleteAtHead).not.toHaveBeenCalled()
  })

  it('keeps later branches without asking while a hung review host is fresh, then asks again', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const hung = vi.fn(() => new Promise<boolean>(() => {}))
    const first = settlePreservedBranchWithForge(kept, {
      reviewHostKey: 'repo',
      confirmMergedAtHead: hung,
      deleteAtHead: vi.fn()
    })
    await vi.advanceTimersByTimeAsync(FORGE_MERGED_LOOKUP_TIMEOUT_MS)
    await expect(first).resolves.toBe(kept)

    const confirmMergedAtHead = vi.fn().mockResolvedValue(true)
    const deleteAtHead = vi.fn().mockResolvedValue(undefined)
    const settlement = { reviewHostKey: 'repo', confirmMergedAtHead, deleteAtHead }
    await expect(settlePreservedBranchWithForge(kept, settlement)).resolves.toBe(kept)
    expect(confirmMergedAtHead).not.toHaveBeenCalled()
    // Another repo has its own review host answer.
    await expect(
      settlePreservedBranchWithForge(kept, { ...settlement, reviewHostKey: 'other-repo' })
    ).resolves.toEqual({})

    await vi.advanceTimersByTimeAsync(FORGE_UNANSWERED_WINDOW_MS)
    await expect(settlePreservedBranchWithForge(kept, settlement)).resolves.toEqual({})
    expect(confirmMergedAtHead).toHaveBeenCalledTimes(2)
  })

  it('keeps asking after a lookup fails fast', async () => {
    const settlement = {
      reviewHostKey: 'repo',
      confirmMergedAtHead: vi.fn().mockRejectedValue(new Error('rate_limited')),
      deleteAtHead: vi.fn()
    }
    await settlePreservedBranchWithForge(kept, settlement)
    await settlePreservedBranchWithForge(kept, settlement)

    expect(settlement.confirmMergedAtHead).toHaveBeenCalledTimes(2)
  })

  it('keeps the branch when the guarded delete refuses', async () => {
    await expect(
      settlePreservedBranchWithForge(kept, {
        reviewHostKey: 'repo',
        confirmMergedAtHead: vi.fn().mockResolvedValue(true),
        deleteAtHead: vi
          .fn()
          .mockRejectedValue(new Error('changed after the workspace was deleted'))
      })
    ).resolves.toBe(kept)
  })

  it('never asks the forge when Git already deleted the branch, or without a saved head', async () => {
    const confirmMergedAtHead = vi.fn()
    const settlement = { reviewHostKey: 'repo', confirmMergedAtHead, deleteAtHead: vi.fn() }

    await expect(settlePreservedBranchWithForge({}, settlement)).resolves.toEqual({})
    const headless = { preservedBranch: { branchName: 'feature/test' } }
    await expect(settlePreservedBranchWithForge(headless, settlement)).resolves.toBe(headless)
    expect(confirmMergedAtHead).not.toHaveBeenCalled()
  })
})
