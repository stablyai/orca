import { watch, type FSWatcher } from 'node:fs'
import { basename, dirname } from 'node:path'

export type TranscriptNativeWatcher = {
  /** Best-effort bind; false keeps the caller in reconciliation-only mode. */
  bind: () => boolean
  /** Detach from an identity that may no longer represent the watched path. */
  invalidate: () => void
  needsRebind: () => boolean
  dispose: () => void
}

/**
 * Optional fs.watch acceleration for transcript reconciliation. Native watches
 * can fail on otherwise-readable remote filesystems, so binding is retryable
 * and never owns transcript liveness; the caller's polling loop does.
 */
export function createTranscriptNativeWatcher(
  filePath: string,
  onEvent: () => void,
  onError: () => void
): TranscriptNativeWatcher {
  const watchedName = basename(filePath)
  let disposed = false
  let watcher: FSWatcher | null = null
  let rebindNeeded = true

  function invalidateCandidate(candidate: FSWatcher): void {
    if (watcher !== candidate) {
      return
    }
    watcher = null
    rebindNeeded = true
    candidate.close()
  }

  return {
    bind(): boolean {
      if (disposed || watcher) {
        return watcher !== null
      }
      let nextWatcher: FSWatcher
      try {
        // Why: watching the parent survives target-file replacement on macOS.
        nextWatcher = watch(dirname(filePath), (event, changedName) => {
          if (changedName !== null && changedName.toString() !== watchedName) {
            return
          }
          // Why: a parent replacement may emit rename without a watcher error.
          if (event === 'rename') {
            invalidateCandidate(nextWatcher)
          }
          onEvent()
        })
      } catch {
        rebindNeeded = true
        return false
      }
      // Why: an active tail should not keep a headless runtime alive during shutdown.
      nextWatcher.unref?.()
      nextWatcher.on('error', () => {
        if (disposed || watcher !== nextWatcher) {
          return
        }
        invalidateCandidate(nextWatcher)
        onError()
      })
      watcher = nextWatcher
      rebindNeeded = false
      return true
    },
    invalidate(): void {
      if (watcher) {
        invalidateCandidate(watcher)
      } else {
        rebindNeeded = true
      }
    },
    needsRebind: () => rebindNeeded,
    dispose(): void {
      disposed = true
      watcher?.close()
      watcher = null
      rebindNeeded = false
    }
  }
}
