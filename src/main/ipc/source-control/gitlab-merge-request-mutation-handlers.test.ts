import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence/loading-store/store'
import { repo } from './gitlab-ipc-repository-fixture'
import type * as RepoAccess from './gitlab-repo-access'

const { ipcHandlers, updateMRMock, invalidateMock } = vi.hoisted(() => ({
  ipcHandlers: new Map<string, (...args: unknown[]) => unknown>(),
  updateMRMock: vi.fn(),
  invalidateMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      ipcHandlers.set(channel, handler)
    })
  }
}))
vi.mock('../../gitlab/merge-request-update', () => ({ updateMR: updateMRMock }))
vi.mock('../../source-control/hosted-review-branch-cache', () => ({
  invalidateHostedReviewBranchCache: invalidateMock
}))
vi.mock('./gitlab-repo-access', async (importActual) => ({
  ...(await importActual<typeof RepoAccess>()),
  localGitOptionArgs: () => []
}))

import { registerGitLabMergeRequestMutationHandlers } from './gitlab-merge-request-mutation-handlers'

const store = { getRepos: () => [repo()], getRepo: () => undefined } as unknown as Store

function updateMR(): unknown {
  return ipcHandlers.get('gitlab:updateMR')?.(null, {
    repoPath: '/local/orca',
    iid: 8,
    updates: { approval: 'approve' }
  })
}

describe('gitlab:updateMR review cache invalidation', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    updateMRMock.mockReset()
    invalidateMock.mockReset()
    registerGitLabMergeRequestMutationHandlers(store)
  })

  it('invalidates the review cache after an MR update', async () => {
    updateMRMock.mockResolvedValueOnce({ ok: true })
    await expect(updateMR()).resolves.toEqual({ ok: true })
    // Why: the sidebar refresh reads through the host's 60s review cache.
    expect(invalidateMock).toHaveBeenCalledWith('/local/orca', 'local')
  })

  it('invalidates the review cache even when the MR update rejects', async () => {
    updateMRMock.mockRejectedValueOnce(new Error('timeout'))
    await expect(updateMR()).rejects.toThrow('timeout')
    // Why: a lost response does not prove the write did not land.
    expect(invalidateMock).toHaveBeenCalledWith('/local/orca', 'local')
  })
})
