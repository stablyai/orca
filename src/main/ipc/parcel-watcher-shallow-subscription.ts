import { statSync, watch } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Event as ParcelWatcherEvent } from '@parcel/watcher'
import { createShallowWatcherBinding, type ShallowWatcherBinding } from './shallow-watcher-binding'

export type ShallowWatcherSubscription = {
  unsubscribe: () => Promise<void>
}

// Why: fs.watch binds to an inode, not a path, and reports nothing when that
// inode is replaced — no error, no events, permanently (verified on Linux and
// Windows). Git replaces `.git/logs` on some maintenance paths, and a repo
// re-clone replaces the common dir itself, so the binding is re-checked on a
// bounded cadence. Two stats per interval is the whole steady-state cost.
const REBIND_CHECK_INTERVAL_MS = 30_000

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

  const watchers = new Map<string, ShallowWatcherBinding>()
  const ownedBindings = new Set<ShallowWatcherBinding>()
  let unsubscribePromise: Promise<void> | undefined
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

  const watchDirectory = (parent: string, fileNames: Set<string>, rebind = false): void => {
    const existing = watchers.get(parent)
    if (existing) {
      if (!rebind) {
        return
      }
      watchers.delete(parent)
      void existing.close().catch(reportError)
    }
    const directoryPath = join(rootPath, parent)
    // Read before watch so a replacement in the gap is detected by the next sweep.
    const identity = directoryIdentitySync(parent)
    try {
      let binding: ShallowWatcherBinding
      const watcher = watch(directoryPath, { persistent: false }, (eventType, fileName) => {
        if (disposed || watchers.get(parent) !== binding) {
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
      binding = createShallowWatcherBinding(
        watcher,
        identity,
        () => {
          ownedBindings.delete(binding)
          if (watchers.get(parent) === binding) {
            watchers.delete(parent)
          }
        },
        reportError
      )
      ownedBindings.add(binding)
      watchers.set(parent, binding)
    } catch (error) {
      // Nested metadata directories may not exist until Git creates them.
      if (parent === '') {
        reportError(error)
      }
    }
  }

  const directoryIdentitySync = (parent: string): string | null => {
    try {
      const entry = statSync(join(rootPath, parent))
      return entry.isDirectory() ? `${entry.dev}:${entry.ino}` : null
    } catch {
      return null
    }
  }

  const directoryIdentity = async (parent: string): Promise<string | null> => {
    try {
      const entry = await stat(join(rootPath, parent))
      return entry.isDirectory() ? `${entry.dev}:${entry.ino}` : null
    } catch {
      return null
    }
  }

  const refreshBinding = async (parent: string, fileNames: Set<string>): Promise<void> => {
    const existing = watchers.get(parent)
    const identity = await directoryIdentity(parent)
    if (disposed || identity === null || watchers.get(parent) !== existing) {
      return
    }
    const bound = existing?.identity
    if (bound === identity) {
      return
    }
    // Either the directory appeared after we started, or it was replaced while
    // watched. Both leave the old binding deaf, so rebind and resync.
    watchDirectory(parent, fileNames, true)
    if (bound !== undefined) {
      emitUpdates(parent, fileNames)
    }
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
    watchDirectory(parent, fileNames)
  }

  return {
    unsubscribe: () => {
      if (!unsubscribePromise) {
        disposed = true
        clearInterval(rebindTimer)
        unsubscribePromise = Promise.all([...ownedBindings].map((binding) => binding.close())).then(
          () => undefined
        )
      }
      return unsubscribePromise
    }
  }
}
