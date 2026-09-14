import type { GitHandlerOperationHost } from './git-handler-operation-context'
import { GitHandlerReadOperations } from './git-handler-read-operations'
import { GitHandlerWorktreeChangeOperations } from './git-handler-worktree-change-operations'
import { GitHandlerDiscardOperations } from './git-handler-discard-operations'
import { GitHandlerComparisonOperations } from './git-handler-comparison-operations'
import { GitHandlerFetchOperations } from './git-handler-fetch-operations'
import { GitHandlerSyncOperations } from './git-handler-sync-operations'
import { GitHandlerObjectDiffOperations } from './git-handler-object-diff-operations'
import { GitHandlerExecOperations } from './git-handler-exec-operations'
import { GitHandlerWorktreeOperations } from './git-handler-worktree-operations'

export function createGitHandlerOperationSet(host: GitHandlerOperationHost) {
  const read = new GitHandlerReadOperations(host)
  const changes = new GitHandlerWorktreeChangeOperations(host)
  const discard = new GitHandlerDiscardOperations(host)
  const comparison = new GitHandlerComparisonOperations(host)
  const fetch = new GitHandlerFetchOperations(host)
  const sync = new GitHandlerSyncOperations(host)
  const objectDiff = new GitHandlerObjectDiffOperations(host)
  const exec = new GitHandlerExecOperations(host)
  const worktree = new GitHandlerWorktreeOperations(host)

  return {
    read,
    changes,
    discard,
    comparison,
    fetch,
    sync,
    objectDiff,
    exec,
    worktree
  }
}

export type GitHandlerOperationSet = ReturnType<typeof createGitHandlerOperationSet>
