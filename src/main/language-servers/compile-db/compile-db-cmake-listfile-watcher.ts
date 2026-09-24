// CMakeLists.txt change watcher (spec D9): a `cmake` configure regenerates the
// compile db, and clangd auto-reloads when that db file changes in place. So a
// CMakeLists.txt edit re-runs configure and navigation returns to full without
// restarting clangd. Watches the worktree root (survives CMakeLists.txt
// replacement on every platform) and filters to the listfile name. The
// underlying `watch` is injectable so tests drive the change callback without
// relying on real fs timing.
import { watch, type FSWatcher, type WatchEventType } from 'node:fs'
import { basename } from 'node:path'

/** The listfile Orca regenerates on; case-insensitive on case-insensitive FSs. */
const CMAKELISTS_FILENAME = 'CMakeLists.txt'

/** Coalesce a burst of editor saves into one configure run. */
export const DEBOUNCE_DEFAULT_MS = 500

export type WatchEventTypeLike = WatchEventType

export type ListfileWatcherOptions = {
  /** Injectable for tests; defaults to node:fs `watch`. */
  watchImpl?: typeof watch
  /** Override the debounce window for deterministic tests. */
  debounceMs?: number
}

export type CMakeListfileWatcher = {
  dispose(): void
}

/**
 * Watches `worktreeRoot` for CMakeLists.txt edits and calls `onChange` (after a
 * short debounce) when one lands. Never throws — a bind failure or watcher
 * error routes to `onError` and the caller falls back to manual regeneration.
 */
export function createCMakeListfileWatcher(
  worktreeRoot: string,
  onChange: () => void,
  onError: () => void,
  watchImpl: typeof watch = watch,
  debounceMs: number = DEBOUNCE_DEFAULT_MS
): CMakeListfileWatcher {
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let watcher: FSWatcher | null = null

  const schedule = (): void => {
    if (disposed) {
      return
    }
    if (timer) {
      clearTimeout(timer)
    }
    timer = setTimeout(() => {
      timer = null
      if (!disposed) {
        onChange()
      }
    }, debounceMs)
    timer.unref?.()
  }

  try {
    watcher = watchImpl(worktreeRoot, (_event: WatchEventType, filename: string | null) => {
      if (!filename) {
        return
      }
      if (basename(filename) === CMAKELISTS_FILENAME) {
        schedule()
      }
    })
    watcher.on('error', () => {
      if (disposed) {
        return
      }
      onError()
    })
    watcher.unref?.()
  } catch {
    // A failed bind is non-fatal: the caller keeps single-shot configure and
    // surfaces no error. Retry-on-next-open covers remounts.
  }

  return {
    dispose(): void {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      watcher?.close()
      watcher = null
    }
  }
}
