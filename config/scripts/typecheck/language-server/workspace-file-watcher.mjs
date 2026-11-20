import { realpathSync, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../../../../src/main/ipc/filesystem/watchers/filesystem-watcher-ignore.ts'

// Orca's usual exclusions at any depth, except build/ and dist/, which hold tracked source below the root.
const NESTED_IGNORED_DIRS = WATCHER_IGNORE_DIRS.filter((dir) => dir !== 'dist' && dir !== 'build')
// The OS drops these paths before delivery; FSEvents takes at most eight. Installs are caught by watchInstalls.
const ROOT_IGNORED_PATHS = ['.git', 'node_modules', 'out', 'dist', 'build', 'coverage', 'release']
const INSTALL_POLL_MS = 2000

function logWatchError(error) {
  console.error(`agent-typescript-lsp: file watch failed: ${error.message}`)
}

// One recursive subscription for the whole workspace, instead of a native stream per watched path.
export function watchWorkspace(root, onEvents, onFailed) {
  let stopped = false
  let subscription = null
  let realRoot = root
  try {
    realRoot = realpathSync(root)
  } catch {}
  // The OS reports real paths; the server's watch globs use the root it was given.
  const toRootPath = (path) => (realRoot === root || !path.startsWith(realRoot) ? path : root + path.slice(realRoot.length))
  const options = { ...buildParcelWatcherIgnoreOptions(NESTED_IGNORED_DIRS), ignore: ROOT_IGNORED_PATHS }
  import('@parcel/watcher')
    .then((watcher) =>
      watcher.subscribe(
        realRoot,
        (error, events) => {
          if (error) {
            logWatchError(error)
            if (!stopped) {
              onFailed()
            }
          } else {
            onEvents(events.map((event) => ({ type: event.type, path: toRootPath(event.path) })))
          }
        },
        options
      )
    )
    .then((active) => {
      if (stopped) {
        void active.unsubscribe()
      } else {
        subscription = active
      }
    })
    .catch((error) => {
      logWatchError(error)
      if (!stopped) {
        onFailed()
      }
    })
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
    // A missing marker (mtime 0) means an install is still running; its final write fires again.
    if (current.mtimeMs > 0 && current.mtimeMs !== previous.mtimeMs) {
      onInstall()
    }
  }
  watchFile(marker, { interval: INSTALL_POLL_MS, persistent: false }, listener)
  return () => unwatchFile(marker, listener)
}
