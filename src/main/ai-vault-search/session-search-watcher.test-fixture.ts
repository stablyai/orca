import { vi } from 'vitest'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WatcherProcessCallback } from '../ipc/filesystem/watcher-process/parcel-watcher-process-subscription'

const watchers = vi.hoisted(() => new Map<string, WatcherProcessCallback>())
vi.mock('../ipc/filesystem/watcher-process/parcel-watcher-process-supervisor', () => ({
  WatcherProcessSupervisor: class {
    async subscribe(path: string, callback: WatcherProcessCallback) {
      watchers.set(path, callback)
      return {
        unsubscribe: async () => {
          watchers.delete(path)
        }
      }
    }
    async disposeAndWait() {
      watchers.clear()
    }
  }
}))

export function notifySessionSearchRootChanges(): void {
  for (const [path, callback] of watchers) {
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
  for (const [root, callback] of watchers) {
    if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) {
      callback(null, [{ path, type: 'update', isDirectory: false }])
    }
  }
}
