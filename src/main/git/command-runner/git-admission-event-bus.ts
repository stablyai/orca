import type { GitAdmissionEvent } from './git-admission-state'

// Why a module-level set rather than scheduler config: the scheduler instance is
// swapped by tests, and a subscriber's lifetime is one long-running command.
const pressureListeners = new Set<(event: GitAdmissionEvent) => void>()

/**
 * Observe admission events so long-running background work can get out of the
 * way when other git commands start queueing behind it.
 *
 * A `pack-refs` on a degraded repository holds a general slot for minutes; that
 * is fine while nothing else wants one and unacceptable the moment something
 * does. Listeners must not throw and must not block.
 */
export function subscribeGitAdmissionEvents(
  listener: (event: GitAdmissionEvent) => void
): () => void {
  pressureListeners.add(listener)
  return () => {
    pressureListeners.delete(listener)
  }
}

export function publishAdmissionEvent(event: GitAdmissionEvent): void {
  for (const listener of pressureListeners) {
    try {
      listener(event)
    } catch {
      // Measurement must never affect admission.
    }
  }
}
