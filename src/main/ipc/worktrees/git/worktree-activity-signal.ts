import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'

// An agent turn or shell command just finished in a worktree; that repo's git-common owners re-check it (throttled).
type RepoActivityListener = () => void

export type RepoActivitySubscription = {
  /** Replaces the repos this listener hears; an event reaches only the listeners of its repo. */
  setRepoIds: (repoIds: Iterable<string>) => void
  unsubscribe: () => void
}

const listenersByRepoId = new Map<string, Set<RepoActivityListener>>()

export function notifyWorktreeActivity(worktreeId: string | undefined): void {
  if (!worktreeId || listenersByRepoId.size === 0) {
    return
  }
  const listeners = listenersByRepoId.get(getRepoIdFromWorktreeId(worktreeId))
  if (!listeners) {
    return
  }
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

export function onRepoActivity(listener: RepoActivityListener): RepoActivitySubscription {
  let repoIds = new Set<string>()
  const remove = (repoId: string): void => {
    const listeners = listenersByRepoId.get(repoId)
    listeners?.delete(listener)
    if (listeners?.size === 0) {
      listenersByRepoId.delete(repoId)
    }
  }
  return {
    setRepoIds: (next) => {
      const nextIds = new Set(next)
      for (const repoId of repoIds) {
        if (!nextIds.has(repoId)) {
          remove(repoId)
        }
      }
      for (const repoId of nextIds) {
        let listeners = listenersByRepoId.get(repoId)
        if (!listeners) {
          listeners = new Set()
          listenersByRepoId.set(repoId, listeners)
        }
        listeners.add(listener)
      }
      repoIds = nextIds
    },
    unsubscribe: () => {
      for (const repoId of repoIds) {
        remove(repoId)
      }
      repoIds = new Set()
    }
  }
}
