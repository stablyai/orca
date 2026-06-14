// Why: spawns the file-watcher worker thread and adapts it to the synchronous
// `watchFileExplorer` contract (a promise that resolves to an unsubscribe fn
// once the recursive crawl is live). Running @parcel/watcher in the worker
// keeps its blocking initial crawl off the main process's libuv pool so a huge
// non-git tree can't wedge the `serve` runtime (issue #5308).
import { Worker } from 'worker_threads'
import { join } from 'path'
import { app } from 'electron'
import type { FsChangeEvent } from '../../shared/types'
import type { FileWatcherHostMessage, FileWatcherWorkerMessage } from './file-watcher-worker'

// Mirrors VS Code's predefined recursive-watch excludes: skip churny generated
// trees at crawl time so the watcher never traverses them.
const RUNTIME_FILE_WATCH_IGNORE = [
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.cache',
  '__pycache__',
  'target',
  '.venv'
]

function getFileWatcherWorkerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'file-watcher-worker.js')
  }
  return join(__dirname, 'file-watcher-worker.js')
}

/** Start a recursive file watch in a worker thread. Resolves to an unsubscribe
 *  function once the worker reports the crawl is live; rejects if the worker
 *  fails to start the watch. */
export function watchFileExplorerInWorker(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(getFileWatcherWorkerPath(), {
      workerData: { rootPath, ignore: RUNTIME_FILE_WATCH_IGNORE }
    })

    let ready = false
    let disposed = false

    // Why: returns a promise that resolves once the worker is actually down, so
    // the shutdown drain (awaitRuntimeFileWatcherUnsubscribes) doesn't finish
    // while the native watcher thread is still alive.
    const dispose = async (): Promise<void> => {
      if (disposed) {
        return
      }
      disposed = true
      // Ask the worker to unsubscribe its native watcher, then terminate as a
      // backstop in case the worker is wedged and never closes its own port.
      try {
        worker.postMessage({ type: 'unsubscribe' } satisfies FileWatcherHostMessage)
      } catch {
        // Worker already gone — terminate below covers it.
      }
      await worker.terminate().then(
        () => undefined,
        () => undefined
      )
    }

    worker.on('message', (message: FileWatcherWorkerMessage) => {
      if (message.type === 'ready') {
        ready = true
        resolve(dispose)
        return
      }
      if (message.type === 'events') {
        if (!disposed) {
          callback(message.events)
        }
        return
      }
      if (message.type === 'error') {
        if (!ready) {
          // The crawl never went live — fail the watch so the caller knows.
          disposed = true
          void worker.terminate()
          reject(new Error(message.message))
          return
        }
        // Already live: a mid-stream watcher error. Tell the renderer to
        // refresh; the worker also emits an overflow event alongside this.
        console.error('[runtime-files.watch] worker error', { rootPath, error: message.message })
      }
    })

    worker.on('error', (err) => {
      if (!ready) {
        disposed = true
        reject(err)
        return
      }
      // A live worker crashed: surface an overflow so the renderer re-reads,
      // rather than silently going stale.
      console.error('[runtime-files.watch] worker crashed', { rootPath, err })
      if (!disposed) {
        callback([{ kind: 'overflow', absolutePath: rootPath }])
      }
    })

    worker.on('exit', (code) => {
      if (!ready && !disposed) {
        disposed = true
        reject(new Error(`file watcher worker exited before ready (code ${code})`))
      }
    })
  })
}
