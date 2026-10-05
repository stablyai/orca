import { statSync, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import { watcherDirectoryIdentity } from './watcher-directory-identity'

export type ShallowWatcherSubscription = {
  unsubscribe: () => Promise<void>
}

// Why: fs.watch binds to an inode, not a path, and reports nothing when that
// inode is replaced — no error, no events, permanently (verified on Linux and
// Windows). Git replaces `.git/logs` on some maintenance paths, and a repo
// re-clone replaces the common dir itself, so the binding is re-checked on a
// bounded cadence. Two stats per interval is the whole steady-state cost.
const REBIND_CHECK_INTERVAL_MS = 30_000

function closeFileSystemWatcher(watcher: FSWatcher): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  watcher.once('close', resolve)
  try {
    watcher.close()
  } catch {
    resolve()
  }
  return promise
}

export function startShallowWatcher(
  rootPath: string,
  relativePaths: readonly string[],
  onEvents: (events: ParcelWatcherEvent[]) => void,
  onError: (error: Error) => void
): ShallowWatcherSubscription {
  const pathsByDirectory = new Map<string, Set<string>>()
  for (const relativePath of relativePaths) {
    const parts = relativePath
      .split(process.platform === 'win32' ? /[\\/]+/ : /\/+/)
      .filter(Boolean)
    const fileName = parts.pop()
    if (!fileName) {
      continue
    }
    const parent = parts.join('/')
    const fileNames = pathsByDirectory.get(parent) ?? new Set<string>()
    fileNames.add(fileName)
    pathsByDirectory.set(parent, fileNames)
  }

  const watchers = new Map<string, FSWatcher>()
  const boundIdentities = new Map<string, string>()
  let disposed = false
  let reportedError = false

  const reportError = (error: unknown): void => {
    if (disposed || reportedError) {
      return
    }
    reportedError = true
    onError(error instanceof Error ? error : new Error(String(error)))
  }

  const emitUpdates = (parent: string, fileNames: Iterable<string>): void => {
    onEvents(
      [...fileNames].map((fileName) => ({
        type: 'update' as const,
        path: join(rootPath, parent, fileName)
      }))
    )
  }

  const watchDirectory = (parent: string, fileNames: Set<string>, rebind = false): boolean => {
    const existing = watchers.get(parent)
    if (existing) {
      if (!rebind) {
        return true
      }
      watchers.delete(parent)
      boundIdentities.delete(parent)
      void closeFileSystemWatcher(existing)
    }
    const directoryPath = join(rootPath, parent)
    try {
      const watcher = watch(directoryPath, { persistent: false }, (eventType, fileName) => {
        if (disposed) {
          return
        }
        const name = fileName?.toString()
        if (!name) {
          emitUpdates(parent, fileNames)
          return
        }
        if (parent === '' && pathsByDirectory.has(name)) {
          const nestedNames = pathsByDirectory.get(name)
          if (nestedNames) {
            // 'rename' is a create/delete of the nested dir itself, so the
            // existing binding (if any) is stale and must be replaced.
            watchDirectory(name, nestedNames, eventType === 'rename')
            emitUpdates(name, nestedNames)
          }
        }
        if (fileNames.has(name)) {
          emitUpdates(parent, [name])
        }
      })
      watcher.on('error', reportError)
      watchers.set(parent, watcher)
      return true
    } catch (error) {
      // Nested metadata directories may not exist until Git creates them.
      if (parent === '') {
        reportError(error)
      }
      return false
    }
  }

  const directoryIdentitySync = (parent: string): string | null => {
    try {
      const entry = statSync(join(rootPath, parent), { bigint: true })
      return watcherDirectoryIdentity(entry)
    } catch {
      return null
    }
  }

  const directoryIdentity = async (parent: string): Promise<string | null> => {
    try {
      const entry = await stat(join(rootPath, parent), { bigint: true })
      return watcherDirectoryIdentity(entry)
    } catch {
      return null
    }
  }

  const refreshBinding = async (parent: string, fileNames: Set<string>): Promise<void> => {
    const identity = await directoryIdentity(parent)
    if (disposed || identity === null) {
      return
    }
    const bound = boundIdentities.get(parent)
    if (bound === identity) {
      return
    }
    // Either the directory appeared after we started, or it was replaced while
    // watched. Both leave the old binding deaf, so rebind and resync.
    if (!watchDirectory(parent, fileNames, true)) {
      return
    }
    boundIdentities.set(parent, identity)
    emitUpdates(parent, fileNames)
  }

  const rebindTimer = setInterval(() => {
    if (disposed) {
      return
    }
    for (const [parent, fileNames] of pathsByDirectory) {
      void refreshBinding(parent, fileNames)
    }
  }, REBIND_CHECK_INTERVAL_MS)
  rebindTimer.unref?.()

  for (const [parent, fileNames] of pathsByDirectory) {
    // Why: read identity BEFORE binding. If the directory is replaced in the gap,
    // the recorded identity is stale and the first sweep rebinds — the harmless
    // direction. Reading after would pin the dead inode's watcher to the new
    // identity, and the sweep would then never rebind it.
    const identityBeforeBind = directoryIdentitySync(parent)
    watchDirectory(parent, fileNames)
    if (watchers.has(parent) && identityBeforeBind !== null) {
      boundIdentities.set(parent, identityBeforeBind)
    }
  }

  return {
    unsubscribe: async () => {
      disposed = true
      clearInterval(rebindTimer)
      await Promise.all([...watchers.values()].map(closeFileSystemWatcher))
    }
  }
}
