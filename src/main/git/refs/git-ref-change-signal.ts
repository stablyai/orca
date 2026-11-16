import { gitRepositoryPathKey } from '../../../shared/git/metadata/git-repository-path-key'
type Listener = () => void
const listeners = new Map<string, Set<Listener>>()

export function subscribeGitRefChanges(commonDir: string, listener: Listener): () => void {
  commonDir = gitRepositoryPathKey(commonDir)
  const subscribers = listeners.get(commonDir) ?? new Set<Listener>()
  subscribers.add(listener)
  listeners.set(commonDir, subscribers)
  return () => {
    subscribers.delete(listener)
    if (subscribers.size === 0 && listeners.get(commonDir) === subscribers) {
      listeners.delete(commonDir)
    }
  }
}

/** Unknown checkout ownership fences every live reader without delaying the mutation for discovery. */
export function publishGitRefChange(commonDir: string | null): void {
  commonDir = commonDir === null ? null : gitRepositoryPathKey(commonDir)
  const targets = commonDir === null ? [...listeners.values()] : [listeners.get(commonDir)]
  for (const subscribers of targets) {
    const callbacks = Array.from(subscribers ?? [])
    for (const listener of callbacks) {
      try {
        listener()
      } catch {
        // Cache bookkeeping must never refuse a Git action.
      }
    }
  }
}

export function beginGitRefMutation(commonDir: string | null): () => void {
  publishGitRefChange(commonDir)
  let ended = false
  return () => {
    if (ended) {
      return
    }
    ended = true
    publishGitRefChange(commonDir)
  }
}
