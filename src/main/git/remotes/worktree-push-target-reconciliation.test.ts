import { expect, it, vi } from 'vitest'
import type * as GitExecFileModule from '../command-runner/git-exec-file'
import type * as WorktreeScanCacheModule from '../worktrees/catalog/worktree-scan-cache'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import { composeWorktreeId } from '../../../shared/worktree/id'

const mocks = vi.hoisted(() => ({
  strictList: vi.fn(),
  execGit: vi.fn()
}))

vi.mock('../worktrees/catalog/worktree-scan-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof WorktreeScanCacheModule>()),
  listWorktreesSharedStrictAllowingTrueEmpty: mocks.strictList
}))

vi.mock('../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: mocks.execGit
}))

import { reconcileOrphanedPrRemotes } from './worktree-push-target-reconciliation'

const REPO_ID = 'repo-under-test'
const REPO_PATH = '/repo'
const REMOTE_NAME = 'pr-head'
const REMOTE_URL = 'https://github.com/fork/orca.git'

function metaWithPushTarget(): WorktreeMeta {
  return {
    displayName: 'task',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    pushTarget: {
      remoteName: REMOTE_NAME,
      branchName: 'task',
      remoteUrl: REMOTE_URL,
      remoteCreated: true
    }
  }
}

it('keeps the PR remote when the worktree listing fails', async () => {
  mocks.strictList.mockRejectedValue(new Error('git worktree list timed out'))
  mocks.execGit.mockResolvedValue({
    stdout: `${REMOTE_NAME}\t${REMOTE_URL} (fetch)\n`,
    stderr: ''
  })
  const store = {
    getAllWorktreeMeta: () => ({
      [composeWorktreeId(REPO_ID, '/repo/still-live')]: metaWithPushTarget()
    })
  }

  await reconcileOrphanedPrRemotes(REPO_PATH, REPO_ID, store)

  const removals = mocks.execGit.mock.calls.filter(
    ([args]) => args[0] === 'remote' && args[1] === 'remove'
  )
  expect(removals).toEqual([])
})
