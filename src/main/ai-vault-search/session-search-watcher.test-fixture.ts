import { vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type {
  WatcherProcessHooks,
  WatcherProcessCallback
} from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'

const watchers = vi.hoisted(
  () =>
    new Map<
      object,
      { path: string; callback: WatcherProcessCallback; hooks: WatcherProcessHooks }
    >()
)
vi.mock('../ipc/filesystem/watcher-process/parcel-watcher-process-supervisor', () => ({
  WatcherProcessSupervisor: class {
    async subscribe(
      path: string,
      callback: WatcherProcessCallback,
      _options: unknown,
      hooks: WatcherProcessHooks = {}
    ) {
      const token = {}
      watchers.set(token, { path, callback, hooks })
      return {
        unsubscribe: async () => {
          watchers.delete(token)
        }
      }
    }
    async disposeAndWait() {
      watchers.clear()
    }
  }
}))

export function notifySessionSearchRootChanges(): void {
  for (const { path, callback } of watchers.values()) {
    const directories = [path]
    for (let index = 0; index < directories.length; index++) {
      try {
        for (const entry of readdirSync(directories[index], { withFileTypes: true })) {
          if (entry.isDirectory()) {
            directories.push(join(directories[index], entry.name))
          }
        }
      } catch {
        /* Refused/missing roots still deliver the root event. */
      }
    }
    callback(
      null,
      directories.map((path) => ({ path, type: 'update', isDirectory: true }))
    )
  }
}

export function notifySessionSearchFileChange(path: string): void {
  for (const { path: root, callback } of watchers.values()) {
    if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
      callback(null, [{ path, type: 'update', isDirectory: false }])
    }
  }
}

export function notifySessionSearchOverflow(path: string): number {
  let delivered = 0
  for (const watch of watchers.values()) {
    if (watch.path === path) {
      if (watch.hooks.onOverflow) {
        watch.hooks.onOverflow()
        delivered++
      }
    }
  }
  return delivered
}
