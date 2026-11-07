import { statSync, watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import { startShallowFileWatcher } from './parcel-watcher-shallow-file-subscription'
import { closeFileSystemWatcher } from './rebinding-file-watch'
import { watcherDirectoryIdentity } from './watcher-directory-identity'

export type ShallowWatcherSubscription = {
  unsubscribe: () => Promise<void>
}

// fs.watch can silently stay bound to a replaced inode; periodically check root and nested directory identity.
const REBIND_CHECK_INTERVAL_MS = 30_000

export function startShallowWatcher(
  rootPath: string,
  relativePaths: readonly string[],
  onEvents: (events: ParcelWatcherEvent[]) => void,
  onError: (error: Error) => void
): ShallowWatcherSubscription {
  // macOS directory watches stream recursive .git churn; watch individual metadata files instead.
  return process.platform === 'darwin'
    ? startShallowFileWatcher(rootPath, relativePaths, onEvents, onError)
    : startShallowDirectoryWatcher(rootPath, relativePaths, onEvents, onError)
}

export function startShallowDirectoryWatcher(
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
            // Rename may replace the directory inode; discard the old binding.
            watchDirectory(name, nestedNames, eventType === 'rename')
            emitUpdates(name, nestedNames)
          }
        }
        if (fileNames.has(name)) {
          emitUpdates(parent, [name])
        }
      })
      watcher.on('error', (error) => {
        // The runtime already closed it; unsubscribe must not wait on its 'close'.
        if (watchers.get(parent) === watcher) {
          watchers.delete(parent)
          boundIdentities.delete(parent)
        }
        reportError(error)
      })
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
    // Appeared or replaced directories need a fresh binding and resync.
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
    // Read identity before binding: a racing replacement then causes a safe rebind instead of pinning a dead watch to the new inode.
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
