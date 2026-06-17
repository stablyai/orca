// Why: spawns the file-watcher worker and adapts it to the synchronous
// `watchFileExplorer` contract (a promise that resolves to an unsubscribe fn
// once the recursive crawl is live). Running @parcel/watcher outside the host
// keeps its blocking initial crawl off the main process's libuv pool and, on
// macOS, lets us isolate native watcher crashes from the Electron main process.
import { Worker } from 'worker_threads'
import { fork, type ChildProcess } from 'child_process'
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

// Why: clean teardown is async (the worker awaits subscription.unsubscribe()
// before closing its port and exiting). Wait this long for the worker to exit on
// its own before force-terminating, so the native watcher thread isn't freed
// mid-flight.
const WORKER_TEARDOWN_TIMEOUT_MS = 5000
type WorkerExitWaitResult = 'exit' | 'timeout'
const CHILD_WORKER_DATA_ENV = 'ORCA_FILE_WATCHER_WORKER_DATA'

function getFileWatcherWorkerPath(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'app.asar', 'out', 'main', 'file-watcher-worker.js')
  }
  return join(__dirname, 'file-watcher-worker.js')
}

function getFileWatcherChildPath(): string {
  if (!app.isPackaged) {
    return join(__dirname, 'file-watcher-worker.js')
  }
  // Why: child_process.fork() runs as plain Node with ELECTRON_RUN_AS_NODE, so
  // it needs a real unpacked file path instead of Electron's asar loader.
  return join(process.resourcesPath, 'app.asar.unpacked', 'out', 'main', 'file-watcher-worker.js')
}

type ExitEmitter = Pick<Worker | ChildProcess, 'once' | 'off'>

function waitForExit(worker: ExitEmitter, timeoutMs: number): Promise<WorkerExitWaitResult> {
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

function createOverflowEvent(rootPath: string): FsChangeEvent[] {
  return [{ kind: 'overflow', absolutePath: rootPath }]
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
      const exitResult = await waitForExit(worker, WORKER_TEARDOWN_TIMEOUT_MS)
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
        callback(createOverflowEvent(rootPath))
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

/** Start a recursive file watch in a forked Node child process. Unlike
 *  worker_threads, this gives native @parcel/watcher crashes a process
 *  boundary: if the addon trips after sleep-wake, Orca stays alive and the
 *  host can refresh/restart the watcher. */
export function watchFileExplorerOutOfProcess(
  rootPath: string,
  callback: (events: FsChangeEvent[]) => void
): Promise<() => Promise<void>> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess | undefined
    let initialReady = false
    let disposed = false
    let disposePromise: Promise<void> | undefined
    let restartTimer: ReturnType<typeof setTimeout> | undefined

    const clearRestartTimer = (): void => {
      if (restartTimer) {
        clearTimeout(restartTimer)
        restartTimer = undefined
      }
    }

    const spawnChild = (): void => {
      if (disposed) {
        return
      }

      const nextChild = fork(getFileWatcherChildPath(), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          [CHILD_WORKER_DATA_ENV]: JSON.stringify({
            rootPath,
            ignore: RUNTIME_FILE_WATCH_IGNORE
          })
        },
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
      })
      child = nextChild
      let childReady = false

      nextChild.stderr?.on('data', (chunk) => {
        console.error('[runtime-files.watch] watcher subprocess stderr', {
          rootPath,
          message: String(chunk).trim()
        })
      })

      nextChild.on('message', (message: FileWatcherWorkerMessage) => {
        if (child !== nextChild || disposed) {
          return
        }
        if (message.type === 'ready') {
          childReady = true
          if (!initialReady) {
            initialReady = true
            resolve(dispose)
          }
          return
        }
        if (message.type === 'events') {
          callback(message.events)
          return
        }
        if (message.type === 'error') {
          if (!childReady) {
            // Why: after a crash restart, a pre-ready child error means this
            // replacement never became a real watcher; let exit schedule retry.
            if (initialReady) {
              console.error('[runtime-files.watch] watcher subprocess failed before ready', {
                rootPath,
                error: message.message
              })
              nextChild.kill()
              return
            }
            disposed = true
            nextChild.kill()
            reject(new Error(message.message))
            return
          }
          console.error('[runtime-files.watch] watcher subprocess error', {
            rootPath,
            error: message.message
          })
        }
      })

      nextChild.on('error', (err) => {
        if (child !== nextChild || disposed) {
          return
        }
        if (!childReady) {
          if (initialReady) {
            child = undefined
            console.error('[runtime-files.watch] watcher subprocess failed before ready', {
              rootPath,
              err
            })
            if (!nextChild.killed) {
              nextChild.kill()
            }
            callback(createOverflowEvent(rootPath))
            clearRestartTimer()
            restartTimer = setTimeout(spawnChild, 1_000)
            return
          }
          disposed = true
          if (!nextChild.killed) {
            nextChild.kill()
          }
          reject(err)
          return
        }
        console.error('[runtime-files.watch] watcher subprocess failed', { rootPath, err })
        callback(createOverflowEvent(rootPath))
      })

      nextChild.on('exit', (code, signal) => {
        if (child !== nextChild) {
          return
        }
        child = undefined
        if (disposed) {
          return
        }
        if (!childReady && !initialReady) {
          disposed = true
          reject(new Error(`file watcher subprocess exited before ready (code ${code})`))
          return
        }
        console.error('[runtime-files.watch] watcher subprocess exited', {
          rootPath,
          code,
          signal
        })
        callback(createOverflowEvent(rootPath))
        clearRestartTimer()
        restartTimer = setTimeout(spawnChild, 1_000)
      })
    }

    const runDispose = async (): Promise<void> => {
      if (disposed) {
        return
      }
      disposed = true
      clearRestartTimer()
      const current = child
      child = undefined
      if (!current || current.killed) {
        return
      }
      try {
        current.send({ type: 'unsubscribe' } satisfies FileWatcherHostMessage)
      } catch {
        // Process already gone — the exit wait and timeout backstop cover it.
      }
      const exitResult = await waitForExit(current, WORKER_TEARDOWN_TIMEOUT_MS)
      if (exitResult === 'timeout' && !current.killed) {
        current.kill()
      }
    }

    const dispose = (): Promise<void> => {
      disposePromise ??= runDispose()
      return disposePromise
    }

    spawnChild()
  })
}
