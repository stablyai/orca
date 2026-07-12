// Why: spawns the file-watcher worker thread and adapts it to the synchronous
// `watchFileExplorer` contract (a promise that resolves to an unsubscribe fn
// once the recursive crawl is live). Running @parcel/watcher in the worker
// keeps its blocking initial crawl off the main process's libuv pool so a huge
// non-git tree can't wedge the `serve` runtime (issue #5308).
import { Worker } from 'node:worker_threads'
import { join } from 'node:path'
import { app } from 'electron'
import type { FsChangeEvent } from '../../shared/types'
import type { FileWatcherHostMessage, FileWatcherWorkerMessage } from './file-watcher-worker'
// Why: shares the explorer watcher's canonical ignore list, pre-shaped so the
// macOS daemon-side exclusion-path cap (8) is respected — over the cap ALL
// exclusions silently fail and fseventsd delivers full node_modules churn.
import {
  WATCHER_IGNORE_DIRS,
  buildParcelWatcherIgnoreOptions
} from '../ipc/filesystem-watcher-ignore'

const RUNTIME_FILE_WATCH_IGNORE_OPTIONS = buildParcelWatcherIgnoreOptions(WATCHER_IGNORE_DIRS)

// Why: clean teardown is async (the worker awaits subscription.unsubscribe()
// before closing its port and exiting). Wait this long for the worker to exit on
// its own before force-terminating, so the native watcher thread isn't freed
// mid-flight.
const WORKER_TEARDOWN_TIMEOUT_MS = 5000
type WorkerExitWaitResult = 'exit' | 'timeout'

function getFileWatcherWorkerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'file-watcher-worker.js')
  }
  return join(__dirname, 'file-watcher-worker.js')
}

function waitForWorkerExit(worker: Worker, timeoutMs: number): Promise<WorkerExitWaitResult> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onExit: (() => void) | undefined
    const finish = (result: WorkerExitWaitResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onExit) {
        worker.off('exit', onExit)
      }
      resolve(result)
    }

    onExit = () => finish('exit')
    worker.once('exit', onExit)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
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
      workerData: { rootPath, ignoreOptions: RUNTIME_FILE_WATCH_IGNORE_OPTIONS }
    })

    let ready = false
    let disposed = false
    let exited = false
    let disposePromise: Promise<void> | undefined

    const runDispose = async (): Promise<void> => {
      if (disposed) {
        return
      }
      disposed = true
      if (exited) {
        return
      }
      // Ask the worker to unsubscribe its native watcher and exit on its own.
      // Why: worker.terminate() force-frees the worker's V8 env while
      // @parcel/watcher's native watch thread / inflight async work is still
      // live, which faults inside napi (Watcher::findCallback,
      // PromiseRunner::onWorkComplete). Only terminate as a backstop if the
      // worker wedges and never exits.
      try {
        worker.postMessage({ type: 'unsubscribe' } satisfies FileWatcherHostMessage)
      } catch {
        // Worker already gone — the exit wait and timeout backstop cover it.
      }
      const exitResult = await waitForWorkerExit(worker, WORKER_TEARDOWN_TIMEOUT_MS)
      if (exitResult === 'timeout' && !exited) {
        await worker.terminate().then(
          () => undefined,
          () => undefined
        )
      }
    }

    // Why: racing dispose callers must share the same worker-exit drain instead
    // of letting later calls resolve while teardown is still in flight.
    const dispose = (): Promise<void> => {
      disposePromise ??= runDispose()
      return disposePromise
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
      exited = true
      if (!ready && !disposed) {
        disposed = true
        reject(new Error(`file watcher worker exited before ready (code ${code})`))
      }
    })
  })
}
