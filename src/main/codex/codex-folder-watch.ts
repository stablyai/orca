import { statSync, type FSWatcher } from 'node:fs'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export type WatchFolder = (path: string, onChange: () => void) => FSWatcher

export type FolderWatch = {
  /** Watches exactly these folders, reopening one replaced under the same name. */
  follow(folders: readonly string[]): void
  close(): void
}

/**
 * One watch per folder, calling `onChange` once a burst of events has been
 * quiet for `settleMs`. Any event counts: macOS can report a burst under the
 * folder's own name, or none. A failed watch is dropped; the next follow reopens it.
 */
export function createFolderWatch(
  watch: WatchFolder,
  onChange: () => void,
  settleMs: number
): FolderWatch {
  const watches = new Map<string, { watcher: FSWatcher; identity: string }>()
  let settle: ReturnType<typeof setTimeout> | null = null
  const changed = (): void => {
    if (settle) {
      clearTimeout(settle)
    }
    settle = setTimeout(() => {
      settle = null
      onChange()
    }, settleMs)
  }
  const drop = (key: string): void => {
    watches.get(key)?.watcher.close()
    watches.delete(key)
  }
  const open = (key: string, folder: string, identity: string): void => {
    try {
      const watcher = watch(folder, changed)
      watcher.on('error', (error) => {
        console.warn('[codex-hook-session] watch failed:', folder, error)
        if (watches.get(key)?.watcher === watcher) {
          drop(key)
        }
      })
      watcher.unref()
      watches.set(key, { watcher, identity })
    } catch (error) {
      console.warn('[codex-hook-session] could not watch:', folder, error)
    }
  }
  return {
    follow(folders) {
      const wanted = new Map(
        folders.map((folder) => [normalizeRuntimePathForComparison(folder), folder])
      )
      for (const key of watches.keys()) {
        if (!wanted.has(key)) {
          drop(key)
        }
      }
      for (const [key, folder] of wanted) {
        const identity = readFolderIdentity(folder)
        if (watches.get(key)?.identity === identity) {
          continue
        }
        drop(key)
        if (identity !== null) {
          open(key, folder, identity)
        }
      }
    },
    close() {
      for (const key of watches.keys()) {
        drop(key)
      }
      if (settle) {
        clearTimeout(settle)
        settle = null
      }
    }
  }
}

// Why the inode too: on Linux a watch follows a folder that was removed, not the one made in its place.
function readFolderIdentity(folder: string): string | null {
  try {
    const info = statSync(folder)
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null
  } catch {
    return null
  }
}
