import { unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../../../../src/main/ipc/filesystem/watchers/filesystem-watcher-ignore.ts'

// The first eight become FSEvents exclusions, so build output is never delivered; installs are caught below.
const IGNORED_DIRS = [
  '.git',
  'node_modules',
  'out',
  'dist',
  'build',
  '.cache',
  'coverage',
  '.turbo',
  ...WATCHER_IGNORE_DIRS.filter((dir) => !['.git', 'node_modules', 'dist', 'build', '.cache', '.turbo'].includes(dir))
]
const INSTALL_POLL_MS = 2000

// One recursive subscription for the whole workspace, instead of a native stream per watched path.
export function watchWorkspace(root, onEvents) {
  let stopped = false
  let subscription = null
  import('@parcel/watcher')
    .then((watcher) =>
      watcher.subscribe(
        root,
        (error, events) => {
          if (error) {
            console.error(`agent-typescript-lsp: file watch failed: ${error.message}`)
          } else {
            onEvents(events)
          }
        },
        buildParcelWatcherIgnoreOptions(IGNORED_DIRS)
      )
    )
    .then((active) => {
      if (stopped) {
        void active.unsubscribe()
      } else {
        subscription = active
      }
    })
    .catch((error) => console.error(`agent-typescript-lsp: file watch failed: ${error.message}`))
  return {
    stop() {
      stopped = true
      void subscription?.unsubscribe()
      subscription = null
    }
  }
}

// pnpm rewrites this marker at the end of every install; polling one file holds no native watch.
export function watchInstalls(root, onInstall) {
  const marker = join(root, 'node_modules', '.modules.yaml')
  const listener = (current, previous) => {
    if (current.mtimeMs !== previous.mtimeMs) {
      onInstall()
    }
  }
  watchFile(marker, { interval: INSTALL_POLL_MS, persistent: false }, listener)
  return () => unwatchFile(marker, listener)
}
