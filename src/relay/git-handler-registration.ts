import type { RelayDispatcher, RequestContext } from './dispatcher'
import type { GitHandlerOperationSet } from './git-handler-operation-set'

export function registerGitHandlers(
  dispatcher: RelayDispatcher,
  handlers: GitHandlerOperationSet,
  responseAck: (params: Record<string, unknown>, context: RequestContext) => void,
  cancelResponseStream: (params: Record<string, unknown>, context: RequestContext) => void
): void {
  dispatcher.onRequest('git.status', (p, context) => handlers.read.getStatus(p, context))
  dispatcher.onRequest('git.submoduleStatus', (p, context) =>
    handlers.read.getSubmoduleStatus(p, context)
  )
  dispatcher.onRequest('git.checkIgnored', (p) => handlers.read.checkIgnored(p))
  dispatcher.onRequest('git.history', (p) => handlers.read.history(p))
  dispatcher.onRequest('git.commit', (p) => handlers.changes.commit(p))
  dispatcher.onRequest('git.diff', (p, context) => handlers.read.getDiff(p, context))
  dispatcher.onRequest('git.stage', (p) => handlers.changes.stage(p))
  dispatcher.onRequest('git.unstage', (p) => handlers.changes.unstage(p))
  dispatcher.onRequest('git.bulkStage', (p) => handlers.changes.bulkStage(p))
  dispatcher.onRequest('git.bulkUnstage', (p) => handlers.changes.bulkUnstage(p))
  dispatcher.onRequest('git.abortMerge', (p) => handlers.changes.abortMerge(p))
  dispatcher.onRequest('git.abortRebase', (p) => handlers.changes.abortRebase(p))
  dispatcher.onRequest('git.checkout', (p) => handlers.changes.checkout(p))
  dispatcher.onRequest('git.localBranches', (p) => handlers.changes.localBranches(p))
  dispatcher.onRequest('git.discard', (p) => handlers.discard.discard(p))
  dispatcher.onRequest('git.bulkDiscard', (p) => handlers.discard.bulkDiscard(p))
  dispatcher.onRequest('git.conflictOperation', (p) => handlers.discard.conflictOperation(p))
  dispatcher.onRequest('git.branchCompare', (p) => handlers.comparison.branchCompare(p))
  dispatcher.onRequest('git.commitCompare', (p) => handlers.comparison.commitCompare(p))
  dispatcher.onRequest('git.upstreamStatus', (p) => handlers.comparison.upstreamStatus(p))
  dispatcher.onRequest('git.fetch', (p) => handlers.fetch.fetch(p))
  dispatcher.onRequest('git.forkSync', (p, context) => handlers.fetch.forkSync(p, context))
  dispatcher.onRequest('git.fetchRemoteTrackingRef', (p) =>
    handlers.fetch.fetchRemoteTrackingRef(p)
  )
  dispatcher.onRequest('git.fetchGitHubPullRequestHead', (p) =>
    handlers.fetch.fetchGitHubPullRequestHead(p)
  )
  dispatcher.onRequest('git.fetchGitLabMergeRequestHead', (p) =>
    handlers.fetch.fetchGitLabMergeRequestHead(p)
  )
  // Why: the durable-ref variant is a distinct method name so an old relay
  // (which only knows FETCH_HEAD-semantics git.fetchGitLabMergeRequestHead)
  // returns -32601 and the client can prompt a reconnect instead of silently
  // resolving a stale/missing ref. Both names share the durable handler: a
  // refspec fetch still writes FETCH_HEAD, so old clients keep their semantics.
  dispatcher.onRequest('git.fetchGitLabMergeRequestHeadRef', (p) =>
    handlers.fetch.fetchGitLabMergeRequestHead(p)
  )
  dispatcher.onRequest('git.push', (p) => handlers.sync.push(p))
  dispatcher.onRequest('git.pull', (p, context) => handlers.sync.pull(p, context))
  dispatcher.onRequest('git.fastForward', (p, context) => handlers.sync.fastForward(p, context))
  dispatcher.onRequest('git.rebaseFromBase', (p, context) =>
    handlers.sync.rebaseFromBase(p, context)
  )
  dispatcher.onRequest('git.branchDiff', (p, context) => handlers.objectDiff.branchDiff(p, context))
  dispatcher.onRequest('git.commitDiff', (p, context) => handlers.objectDiff.commitDiff(p, context))
  dispatcher.onRequest('git.listWorktrees', (p, context) =>
    handlers.worktree.listWorktrees(p, context)
  )
  dispatcher.onRequest('git.addWorktree', (p) => handlers.worktree.addWorktree(p))
  dispatcher.onRequest('git.removeWorktree', (p) => handlers.worktree.removeWorktree(p))
  dispatcher.onRequest('git.worktreeIsClean', (p) => handlers.worktree.worktreeIsClean(p))
  dispatcher.onRequest('git.refreshLocalBaseRefForWorktreeCreate', (p) =>
    handlers.worktree.refreshLocalBaseRefForWorktreeCreate(p)
  )
  dispatcher.onRequest('git.markRemoteOrcaCreated', (p) => handlers.exec.markRemoteOrcaCreated(p))
  dispatcher.onRequest('git.renameCurrentBranch', (p) => handlers.exec.renameCurrentBranch(p))
  dispatcher.onRequest('git.forceDeletePreservedBranch', (p) =>
    handlers.exec.forceDeletePreservedBranch(p)
  )
  dispatcher.onRequest('git.exec', (p, context) => handlers.exec.exec(p, context))
  dispatcher.onRequest('git.clone', (p, context) => handlers.exec.clone(p, context))
  dispatcher.onRequest('git.isGitRepo', (p) => handlers.worktree.isGitRepo(p))
  dispatcher.onNotification('git.responseAck', (p, context) => responseAck(p, context))
  dispatcher.onNotification('git.cancelResponseStream', (p, context) =>
    cancelResponseStream(p, context)
  )
}
