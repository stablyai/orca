import { expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repository/repo-types'
import { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'
import { runHostedPRRead } from '../../../github/pull-requests/refresh/pr-refresh-coordinator'

vi.mock('../../../github/client/lookup/pr-for-branch-outcome', () => ({
  preparePRBranchRead: vi.fn(async () => ({})),
  readRecentPhonePROutcome: vi.fn(async () => null)
}))
vi.mock('../../../github/pull-requests/refresh/pr-refresh-coordinator', () => ({
  runHostedPRRead: vi.fn(),
  runHostedPRSnapshot: vi.fn()
}))

it('hands each served PR read to the host cache recorder with its request hints', async () => {
  const repo: Repo = {
    id: 'repo-1',
    path: '/home/me/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0
  }
  const outcome = {
    kind: 'found' as const,
    pr: {
      number: 42,
      title: 'Feature',
      url: 'https://github.com/o/r/pull/42',
      state: 'merged' as const,
      checksStatus: 'success' as const,
      updatedAt: '',
      mergeable: 'UNKNOWN' as const
    },
    fetchedAt: 1
  }
  vi.mocked(runHostedPRRead).mockResolvedValue(outcome)
  const recordPROutcome = vi.fn()
  const commands = new RuntimeHostedReviewCommands({
    resolveRepo: async () => repo,
    resolveTarget: async () => ({ repo, repoPath: repo.path }),
    getExecutionOptions: () => undefined,
    recordCreated: vi.fn(),
    recordPROutcome
  })
  await commands.getRepoPRForBranch('repo-1', 'feature', 42, null, false, 'abc', 'visible')
  expect(recordPROutcome).toHaveBeenCalledWith(repo, 'feature', outcome, {
    linkedPRNumber: 42,
    currentHeadOid: 'abc'
  })
})
