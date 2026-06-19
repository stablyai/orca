/**
 * Polling-based file watcher for WSL paths.
 *
 * Why: @parcel/watcher uses ReadDirectoryChangesW which doesn't work across
 * the WSL network filesystem boundary (\\wsl.localhost\…).  Instead of
 * requiring the user to install extra tools inside WSL, we poll the
 * directory tree via Node's fs.readdir (which works on UNC paths) and diff
 * against a snapshot to detect changes.  A 2 s poll interval is a good
 * balance between responsiveness and CPU cost — nobody stares at the file
 * explorer waiting for instant refresh.
 */
import type { Dirent } from 'fs'
import { readdir } from 'fs/promises'
import * as path from 'path'
import type { WebContents } from 'electron'
import type { Event as WatcherEvent } from '@parcel/watcher'
import { MAX_BATCHED_WATCHER_EVENTS, queueWatcherEvents } from './filesystem-watcher-event-batch'

export type WatcherSubscription = {
  unsubscribe(): Promise<void>
}

type DebouncedBatch = {
  events: WatcherEvent[]
  overflowed: boolean
  timer: ReturnType<typeof setTimeout> | null
  firstEventAt: number
}

export type WatchedRoot = {
  subscription: WatcherSubscription
  listeners: Map<number, WebContents>
  batch: DebouncedBatch
}

export type WslWatcherDeps = {
  ignoreDirs: string[]
  scheduleBatchFlush: (rootKey: string, root: WatchedRoot) => void
  watchedRoots: Map<string, WatchedRoot>
}

const POLL_INTERVAL_MS = 2000
const SNAPSHOT_CHILD_READ_CONCURRENCY = 8
const DIFF_EVENT_OVERFLOW_LIMIT = MAX_BATCHED_WATCHER_EVENTS + 1

type DirSnapshot = Map<string, Set<string>>

async function readDirEntriesSafe(dirPath: string): Promise<Dirent[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    return entries
  } catch {
    return []
  }
}

function shouldIgnore(name: string, ignoreDirs: string[]): boolean {
  return ignoreDirs.includes(name)
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let nextIndex = 0
  const workerCount = Math.min(limit, items.length)
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const item = items[nextIndex++]
        await worker(item)
      }
    })
  )
}

/**
 * Take a snapshot of the root directory and one level of subdirectories.
 * Returns a map of dirPath → set of entry names.
 */
async function takeSnapshot(rootPath: string, ignoreDirs: string[]): Promise<DirSnapshot> {
  const snapshot: DirSnapshot = new Map()

  const rootEntries = await readDirEntriesSafe(rootPath)
  const filtered = rootEntries.filter((entry) => !shouldIgnore(entry.name, ignoreDirs))
  snapshot.set(rootPath, new Set(filtered.map((entry) => entry.name)))

  // Why: poll one level of subdirectories so changes inside immediate
  // children are detected, but use Dirent metadata to avoid probing every
  // root-level file with a failing readdir on each WSL poll.
  const childDirs = filtered.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
  await forEachWithConcurrency(childDirs, SNAPSHOT_CHILD_READ_CONCURRENCY, async (entry) => {
    const childPath = path.join(rootPath, entry.name)
    const childEntries = await readDirEntriesSafe(childPath)
    const childFiltered = childEntries
      .filter((childEntry) => !shouldIgnore(childEntry.name, ignoreDirs))
      .map((childEntry) => childEntry.name)
    snapshot.set(childPath, new Set(childFiltered))
  })

  return snapshot
}

function appendDiffEvent(events: WatcherEvent[], event: WatcherEvent): boolean {
  events.push(event)
  return events.length >= DIFF_EVENT_OVERFLOW_LIMIT
}

/**
 * Diff two snapshots and return synthetic watcher events.
 */
function diffSnapshots(prev: DirSnapshot, next: DirSnapshot): WatcherEvent[] {
  const events: WatcherEvent[] = []

  for (const [dirPath, nextEntries] of next) {
    const prevEntries = prev.get(dirPath)
    if (!prevEntries) {
      // New directory appeared — emit create for all entries
      for (const name of nextEntries) {
        if (
          appendDiffEvent(events, {
            type: 'create',
            path: path.join(dirPath, name)
          } as WatcherEvent)
        ) {
          return events
        }
      }
      continue
    }

    // Check for new entries (create)
    for (const name of nextEntries) {
      if (!prevEntries.has(name)) {
        if (
          appendDiffEvent(events, {
            type: 'create',
            path: path.join(dirPath, name)
          } as WatcherEvent)
        ) {
          return events
        }
      }
    }

    // Check for removed entries (delete)
    for (const name of prevEntries) {
      if (!nextEntries.has(name)) {
        if (
          appendDiffEvent(events, {
            type: 'delete',
            path: path.join(dirPath, name)
          } as WatcherEvent)
        ) {
          return events
        }
      }
    }
  }

  // Check for directories that disappeared entirely
  for (const [dirPath] of prev) {
    if (!next.has(dirPath)) {
      if (appendDiffEvent(events, { type: 'delete', path: dirPath } as WatcherEvent)) {
        return events
      }
    }
  }

  return events
}

export async function createWslWatcher(
  rootKey: string,
  worktreePath: string,
  deps: WslWatcherDeps
): Promise<WatchedRoot> {
  const root: WatchedRoot = {
    subscription: null!,
    listeners: new Map(),
    batch: { events: [], overflowed: false, timer: null, firstEventAt: 0 }
  }

  // Take initial snapshot
  let prevSnapshot = await takeSnapshot(worktreePath, deps.ignoreDirs)

  let polling = false
  let disposed = false
  const poll = async (): Promise<void> => {
    if (polling || disposed) {
      return
    }
    polling = true
    try {
      const nextSnapshot = await takeSnapshot(worktreePath, deps.ignoreDirs)
      if (disposed) {
        return
      }
      const events = diffSnapshots(prevSnapshot, nextSnapshot)
      prevSnapshot = nextSnapshot

      if (events.length > 0) {
        queueWatcherEvents(root.batch, events)
        deps.scheduleBatchFlush(rootKey, root)
      }
    } catch {
      // Why: if the WSL filesystem becomes temporarily unavailable
      // (e.g. WSL distro shuts down), skip this poll cycle rather
      // than crashing.  The next cycle will retry.
    } finally {
      polling = false
    }
  }

  const intervalId = setInterval(() => {
    // Why: WSL UNC scans can exceed the poll interval on large repos or cold
    // network filesystems. Run at most one tree diff at a time so a slow scan
    // cannot stack concurrent readdir storms on the same root.
    void poll()
  }, POLL_INTERVAL_MS)

  root.subscription = {
    unsubscribe: async () => {
      disposed = true
      clearInterval(intervalId)
    }
  }

  return root
}
