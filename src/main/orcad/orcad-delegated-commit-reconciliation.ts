import { recoverOrcadDelegatedCommit } from './orcad-delegated-commit-recovery'

/** Retry on acknowledged output progress, not a polling loop or a replacement receipt. */
export function createOrcadDelegatedCommitReconciliation(
  options: Parameters<typeof recoverOrcadDelegatedCommit>[0] & {
    isActive: () => boolean
    onError: (error: unknown) => void
    onReconciled?: () => void
  }
) {
  let pending: Promise<void> | undefined
  let requested = false
  let reconciled = false
  const waiters = new Set<() => void>()
  const wake = () => {
    if (!options.isActive() || reconciled) {
      return
    }
    requested = true
    if (pending) {
      return
    }
    pending = Promise.resolve()
      .then(async () => {
        while (requested && options.isActive() && !reconciled) {
          requested = false
          const journal = options.store.load(options.identity)
          if (
            !journal?.receipt ||
            (journal.phase !== 'committed' && journal.phase !== 'published')
          ) {
            return
          }
          const result = await recoverOrcadDelegatedCommit({
            ...options,
            waitForAcknowledgedOutput: true
          })
          if (options.isActive() && result.phase === 'committed') {
            reconciled = true
            for (const ready of waiters) {
              ready()
            }
            options.onReconciled?.()
          }
        }
      })
      .catch((error) => {
        if (options.isActive()) {
          options.onError(error)
        }
      })
      .finally(() => {
        pending = undefined
        if (requested) {
          wake()
        }
      })
  }
  const waitForReconciled = async (signal: AbortSignal) => {
    signal.throwIfAborted()
    if (!options.isActive()) {
      throw new Error('orcad_delegated_commit_recovery_stale')
    }
    if (reconciled) {
      return
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        waiters.delete(ready)
        signal.removeEventListener('abort', abort)
      }
      const ready = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(signal.reason)
      }
      waiters.add(ready)
      signal.addEventListener('abort', abort, { once: true })
      wake()
    })
    signal.throwIfAborted()
    if (!options.isActive()) {
      throw new Error('orcad_delegated_commit_recovery_stale')
    }
  }
  return { wake, waitForReconciled, isReconciled: () => options.isActive() && reconciled }
}
