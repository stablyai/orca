// Project listfile change watcher (spec D9): a build-system configure/
// regenerate step rebuilds the compile db, and clangd auto-reloads when that db
// file changes in place. So an edit to the build system's listfile re-runs the
// step and navigation returns to full without restarting clangd. Watches the
// worktree root (survives listfile replacement on every platform) and filters
// to a caller-supplied set of filenames — CMake passes `['CMakeLists.txt']`,
// GN passes `['BUILD.gn', '.gn']`. The underlying `watch` is injectable so
// tests drive the change callback without relying on real fs timing.
import { watch, type FSWatcher, type WatchEventType } from 'node:fs'
import { basename } from 'node:path'

/** Coalesce a burst of editor saves into one configure run. */
export const DEBOUNCE_DEFAULT_MS = 500

export type WatchEventTypeLike = WatchEventType

export type ListfileWatcherOptions = {
  /** Injectable for tests; defaults to node:fs `watch`. */
  watchImpl?: typeof watch
  /** Override the debounce window for deterministic tests. */
  debounceMs?: number
  /**
   * Watch subdirs too (spec §8 GN: BUILD.gn lives in every package subdir).
   * node:fs `watch({ recursive: true })` is native on Windows/macOS and on
   * Linux ≥5.4 (libuv recursive inotify); false scopes CMake root-only watch.
   */
  recursive?: boolean
}

export type ListfileWatcher = {
  dispose(): void
}

/**
 * Watches `worktreeRoot` for edits to any file in `filenames` and calls
 * `onChange` (after a short debounce) when one lands. Never throws — a bind
 * failure or watcher error routes to `onError` and the caller falls back to
 * manual regeneration. Matching is case-sensitive on the basename (CMakeLists
 * / BUILD.gn / .gn are all case-sensitive filenames on every real project).
 */
export function createListfileWatcher(
  worktreeRoot: string,
  filenames: readonly string[],
  onChange: () => void,
  onError: () => void,
  watchImpl: typeof watch = watch,
  debounceMs: number = DEBOUNCE_DEFAULT_MS,
  recursive: boolean = false
): ListfileWatcher {
  const watched = new Set(filenames.map((name) => basename(name)))
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
    // (dir, { recursive }, cb): node reports subpaths relative to the root,
    // so the basename match below catches src/foo/BUILD.gn as well as .gn.
    watcher = watchImpl(
      worktreeRoot,
      { recursive },
      (_event: WatchEventType, filename: string | null) => {
        if (!filename) {
          return
        }
        if (watched.has(basename(filename))) {
          schedule()
        }
      }
    )
    watcher.on('error', () => {
      if (disposed) {
        return
      }
      onError()
    })
    watcher.unref?.()
  } catch {
    // A failed bind is non-fatal (e.g. recursive on a kernel <5.4): the caller
    // keeps single-shot configure and surfaces no error; retry-on-next-open
    // covers remounts.
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
