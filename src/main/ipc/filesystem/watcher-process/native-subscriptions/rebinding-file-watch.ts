import { statSync, watch, type BigIntStats, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'

// macOS file watches avoid recursive FSEvents churn, but bind an inode; refresh after events/sweeps to follow atomic replacement or creation.

export type RebindingFileWatch = {
  /** Re-stats the path, rebinding and reporting a change if it differs from the last look. */
  refresh: () => Promise<void>
  isBound: () => boolean
  close: () => Promise<void>
}

// macOS mmap reads emit vnode noise; coalesce until stat proves change, backing off noisy events and resetting on real writes.
const EVENT_COALESCE_MS = 200
const MAX_EVENT_COALESCE_MS = 1_600
// Verify on a later loop turn: registration is asynchronous and an earlier stat may miss replacement before binding.
const BIND_VERIFY_DELAY_MS = 50

type FileSnapshot = { identity: string; stamp: string }

// Node error closes handles without close events; later close() may do nothing, so bound the wait.
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
          // Disarm until refresh so hot reads coalesce; the stat still covers writes made meanwhile.
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
        // Read identity before binding so a racing replacement produces a safe verification mismatch.
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
  } catch {}

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
