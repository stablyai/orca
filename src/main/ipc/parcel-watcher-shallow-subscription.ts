import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'

export type ShallowWatcherSubscription = {
  unsubscribe: () => Promise<void>
}

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
    const parts = relativePath.split(/[\\/]+/).filter(Boolean)
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

  const watchDirectory = (parent: string, fileNames: Set<string>): void => {
    if (watchers.has(parent)) {
      return
    }
    const directoryPath = join(rootPath, parent)
    try {
      const watcher = watch(directoryPath, { persistent: false }, (_eventType, fileName) => {
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
            watchDirectory(name, nestedNames)
            emitUpdates(name, nestedNames)
          }
        }
        if (fileNames.has(name)) {
          emitUpdates(parent, [name])
        }
      })
      watcher.on('error', reportError)
      watchers.set(parent, watcher)
    } catch (error) {
      // Nested metadata directories may not exist until Git creates them.
      if (parent === '') {
        reportError(error)
      }
    }
  }

  for (const [parent, fileNames] of pathsByDirectory) {
    watchDirectory(parent, fileNames)
  }

  return {
    unsubscribe: async () => {
      disposed = true
      await Promise.all([...watchers.values()].map(closeFileSystemWatcher))
    }
  }
}
