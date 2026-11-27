import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

// An agent turn or shell command just finished in a worktree; git-common reconciliation re-checks that repo (throttled).
type WorktreeActivityListener = (repoId: string) => void

const listeners = new Set<WorktreeActivityListener>()

export function notifyWorktreeActivity(worktreeId: string | undefined): void {
  if (!worktreeId || listeners.size === 0) {
    return
  }
  const repoId = getRepoIdFromWorktreeId(worktreeId)
  for (const listener of Array.from(listeners)) {
    listener(repoId)
  }
}

export function onWorktreeActivity(listener: WorktreeActivityListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
