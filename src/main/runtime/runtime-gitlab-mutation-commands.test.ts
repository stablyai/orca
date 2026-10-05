import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'

const { updateMRMock, invalidateMock } = vi.hoisted(() => ({
  updateMRMock: vi.fn(),
  invalidateMock: vi.fn()
}))
vi.mock('../gitlab/client', () => ({ updateMR: updateMRMock }))
vi.mock('../source-control/hosted-review-branch-cache', () => ({
  invalidateHostedReviewBranchCache: invalidateMock
}))

import { RuntimeGitLabMutationCommands } from './runtime-gitlab-mutation-commands'
import { getRepoHostedReviewExecutionHostId } from '../source-control/hosted-review-execution-host'

const repo: Repo = {
  id: 'repo-1',
  path: '/remote/repo',
  displayName: 'repo',
  badgeColor: '',
  addedAt: 0,
  connectionId: 'ssh-1'
}

describe('RuntimeGitLabMutationCommands.updateGitLabRepoMR', () => {
  beforeEach(() => {
    updateMRMock.mockReset().mockResolvedValue({ ok: true })
    invalidateMock.mockReset()
  })

  it('invalidates the review cache for the executing host after the write', async () => {
    const commands = new RuntimeGitLabMutationCommands({
      resolveRepo: vi.fn().mockResolvedValue(repo),
      getLocalGitArgs: () => []
    })
    await commands.updateGitLabRepoMR('repo-1', 8, { approval: 'approve' })
    expect(updateMRMock).toHaveBeenCalledWith(
      '/remote/repo',
      8,
      { approval: 'approve' },
      undefined,
      'ssh-1',
      undefined
    )
    expect(invalidateMock).toHaveBeenCalledWith(
      '/remote/repo',
      getRepoHostedReviewExecutionHostId(repo)
    )
    expect(getRepoHostedReviewExecutionHostId(repo)).toBe('ssh:ssh-1')
  })
})
