import { statSync, watch, type BigIntStats, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'

// Why: watching one file instead of its directory keeps macOS off fseventsd — a
// file watch is a kqueue registration there, while a directory watch is a
// recursive FSEvents stream that delivers every write beneath it. A file watch
// binds an inode, though: rename-replace (git lock files, atomic JSON writes)
// leaves it deaf and a missing file cannot be watched at all, so events and
// owner sweeps re-stat the path and rebind when it names a new file.

export type RebindingFileWatch = {
  /** Re-stats the path, rebinding and reporting a change if it differs from the last look. */
  refresh: () => Promise<void>
  isBound: () => boolean
  close: () => Promise<void>
}

// Why: macOS raises a vnode attribute event for every mmap read (git maps the
// index and packed-refs; ~120/s measured on a busy repo), so events are
// coalesced and only a stat that differs counts as a change. An access-time
// update leaves mtime, ctime and size alone. Each event that proves to be
// noise doubles the window, so a file that every git process maps costs about
// one rebind a second; a real change restores the short window.
const EVENT_COALESCE_MS = 200
const MAX_EVENT_COALESCE_MS = 1_600
// Why: the native registration only lands on a later loop turn, and a stat
// already queued can predate a replacement in that gap, which would leave the
// binding on a dead inode. A timer cannot fire before that turn.
const BIND_VERIFY_DELAY_MS = 50

type FileSnapshot = { identity: string; stamp: string }

// Why: Node closes an errored watcher's handle without emitting 'close', and a
// later close() is then a silent no-op, so waiting on 'close' alone can hang.
const WATCHER_CLOSE_TIMEOUT_MS = 1_000

export function closeFileSystemWatcher(watcher: FSWatcher): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  const timer = setTimeout(resolve, WATCHER_CLOSE_TIMEOUT_MS)
  timer.unref?.()
  watcher.once('close', resolve)
  watcher.once('error', () => resolve())
  try {
    watcher.close()
  } catch {
    resolve()
  }
  return promise.finally(() => clearTimeout(timer))
}

function fileSnapshot(entry: BigIntStats): FileSnapshot {
  return {
    // Volumes without inode ids fall back to birth time, which a rename-replace also changes.
    identity:
      entry.ino !== 0n ? `${entry.dev}:${entry.ino}` : `${entry.dev}:birth:${entry.birthtimeNs}`,
    stamp: `${entry.size}:${entry.mtimeNs}:${entry.ctimeNs}`
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export function watchFileAcrossReplacement(
  path: string,
  onChange: () => void,
  onError: (error: Error) => void
): RebindingFileWatch {
  let watcher: FSWatcher | null = null
  let boundIdentity: string | null = null
  let lastSeen: FileSnapshot | null = null
  let closed = false
  let refreshing: Promise<void> | null = null
  let refreshAgain = false
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined
  let coalesceMs = EVENT_COALESCE_MS
  let verifyTimer: ReturnType<typeof setTimeout> | undefined
  const closing = new Set<Promise<void>>()

  const unbind = (): void => {
    const current = watcher
    watcher = null
    boundIdentity = null
    if (current) {
      const pending = closeFileSystemWatcher(current).finally(() => closing.delete(pending))
      closing.add(pending)
    }
  }

  const scheduleCoalescedRefresh = (): void => {
    if (coalesceTimer === undefined) {
      coalesceTimer = setTimeout(() => {
        coalesceTimer = undefined
        coalesceMs = Math.min(coalesceMs * 2, MAX_EVENT_COALESCE_MS)
        void refresh()
      }, coalesceMs)
      coalesceTimer.unref?.()
    }
  }

  const bind = (identity: string): void => {
    try {
      const next = watch(path, { persistent: false }, () => {
        if (!closed && watcher === next) {
          // One-shot: a hot file costs one rebind per window instead of a wakeup
          // per read. The refresh stat covers writes made while disarmed.
          unbind()
          scheduleCoalescedRefresh()
        }
      })
      next.on('error', (error) => {
        if (!closed && watcher === next) {
          // The runtime already closed it; close() would wait for a 'close' that never comes.
          watcher = null
          boundIdentity = null
          onError(error)
        }
      })
      watcher = next
      boundIdentity = identity
      clearTimeout(verifyTimer)
      verifyTimer = setTimeout(() => void refresh(), BIND_VERIFY_DELAY_MS)
      verifyTimer.unref?.()
    } catch (error) {
      if (!isMissingPathError(error)) {
        onError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  const readSnapshot = async (): Promise<FileSnapshot | null> => {
    try {
      return fileSnapshot(await stat(path, { bigint: true }))
    } catch {
      return null
    }
  }

  const refreshOnce = async (): Promise<void> => {
    const current = await readSnapshot()
    if (closed) {
      return
    }
    const changed = current?.identity !== lastSeen?.identity || current?.stamp !== lastSeen?.stamp
    lastSeen = current
    if (current?.identity !== boundIdentity) {
      unbind()
      if (current) {
        // A replacement between the stat and this bind leaves the identity stale,
        // which the bind's verify pass treats as a change: the harmless direction.
        bind(current.identity)
      }
    }
    if (changed) {
      coalesceMs = EVENT_COALESCE_MS
      onChange()
    }
  }

  const refresh = (): Promise<void> => {
    if (refreshing) {
      refreshAgain = true
      return refreshing
    }
    refreshing = (async () => {
      do {
        refreshAgain = false
        await refreshOnce()
      } while (refreshAgain && !closed)
    })().finally(() => {
      refreshing = null
    })
    return refreshing
  }

  try {
    lastSeen = fileSnapshot(statSync(path, { bigint: true }))
    bind(lastSeen.identity)
  } catch {
    // Missing until a refresh finds it.
  }

  return {
    refresh,
    isBound: () => watcher !== null,
    close: async () => {
      closed = true
      clearTimeout(coalesceTimer)
      clearTimeout(verifyTimer)
      unbind()
      await Promise.all(closing)
    }
  }
}
