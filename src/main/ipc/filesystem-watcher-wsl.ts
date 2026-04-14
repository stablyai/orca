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
import { readdir } from 'fs/promises'
import * as path from 'path'
import type { WebContents } from 'electron'
import type { Event as WatcherEvent } from '@parcel/watcher'

export type WatcherSubscription = {
  unsubscribe(): Promise<void>
}

type DebouncedBatch = {
  events: WatcherEvent[]
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

type DirSnapshot = Map<string, Set<string>>

async function readDirSafe(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath)
    return entries
  } catch {
    return []
  }
}

function shouldIgnore(name: string, ignoreDirs: string[]): boolean {
  return ignoreDirs.includes(name)
}

/**
 * Take a snapshot of the root directory and one level of subdirectories.
 * Returns a map of dirPath → set of entry names.
 */
async function takeSnapshot(
  rootPath: string,
  ignoreDirs: string[]
): Promise<DirSnapshot> {
  const snapshot: DirSnapshot = new Map()

  const rootEntries = await readDirSafe(rootPath)
  const filtered = rootEntries.filter((name) => !shouldIgnore(name, ignoreDirs))
  snapshot.set(rootPath, new Set(filtered))

  // Why: poll one level of subdirectories so changes inside immediate
  // children are detected (e.g. editing src/foo.ts).  Going deeper
  // would be too expensive for large repos.  The renderer requests
  // deeper directories explicitly via readDir when the user expands.
  await Promise.all(
    filtered.map(async (name) => {
      const childPath = path.join(rootPath, name)
      try {
        const childEntries = await readDirSafe(childPath)
        const childFiltered = childEntries.filter((n) => !shouldIgnore(n, ignoreDirs))
        snapshot.set(childPath, new Set(childFiltered))
      } catch {
        // Not a directory or inaccessible — skip
      }
    })
  )

  return snapshot
}

/**
 * Diff two snapshots and return synthetic watcher events.
 */
function diffSnapshots(
  prev: DirSnapshot,
  next: DirSnapshot
): WatcherEvent[] {
  const events: WatcherEvent[] = []

  for (const [dirPath, nextEntries] of next) {
    const prevEntries = prev.get(dirPath)
    if (!prevEntries) {
      // New directory appeared — emit create for all entries
      for (const name of nextEntries) {
        events.push({ type: 'create', path: path.join(dirPath, name) } as WatcherEvent)
      }
      continue
    }

    // Check for new entries (create)
    for (const name of nextEntries) {
      if (!prevEntries.has(name)) {
        events.push({ type: 'create', path: path.join(dirPath, name) } as WatcherEvent)
      }
    }

    // Check for removed entries (delete)
    for (const name of prevEntries) {
      if (!nextEntries.has(name)) {
        events.push({ type: 'delete', path: path.join(dirPath, name) } as WatcherEvent)
      }
    }
  }

  // Check for directories that disappeared entirely
  for (const [dirPath] of prev) {
    if (!next.has(dirPath)) {
      events.push({ type: 'delete', path: dirPath } as WatcherEvent)
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
    batch: { events: [], timer: null, firstEventAt: 0 }
  }

  // Take initial snapshot
  let prevSnapshot = await takeSnapshot(worktreePath, deps.ignoreDirs)

  const intervalId = setInterval(async () => {
    try {
      const nextSnapshot = await takeSnapshot(worktreePath, deps.ignoreDirs)
      const events = diffSnapshots(prevSnapshot, nextSnapshot)
      prevSnapshot = nextSnapshot

      if (events.length > 0) {
        root.batch.events.push(...events)
        deps.scheduleBatchFlush(rootKey, root)
      }
    } catch {
      // Why: if the WSL filesystem becomes temporarily unavailable
      // (e.g. WSL distro shuts down), skip this poll cycle rather
      // than crashing.  The next cycle will retry.
    }
  }, POLL_INTERVAL_MS)

  root.subscription = {
    unsubscribe: async () => {
      clearInterval(intervalId)
    }
  }

  return root
}
