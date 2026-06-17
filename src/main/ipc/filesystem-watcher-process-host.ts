import { fork, type ChildProcess } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import type { FsChangeEvent } from '../../shared/types'
import type {
  FilesystemWatcherChildMessage,
  FilesystemWatcherHostMessage
} from './filesystem-watcher-child'

const CHILD_TEARDOWN_TIMEOUT_MS = 5000
const FILESYSTEM_WATCHER_CHILD_DATA_ENV = 'ORCA_FILESYSTEM_WATCHER_CHILD_DATA'

type ExitWaitResult = 'exit' | 'timeout'
type ExitEmitter = Pick<ChildProcess, 'once' | 'off'>

function getFilesystemWatcherChildPath(): string {
  if (!app.isPackaged) {
    return join(__dirname, 'filesystem-watcher-child.js')
  }
  // Why: child_process.fork() runs as plain Node with ELECTRON_RUN_AS_NODE, so
  // it needs a real unpacked file path instead of Electron's asar loader.
  return join(
    process.resourcesPath,
    'app.asar.unpacked',
    'out',
    'main',
    'filesystem-watcher-child.js'
  )
}

function waitForExit(child: ExitEmitter, timeoutMs: number): Promise<ExitWaitResult> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let onExit: (() => void) | undefined
    const finish = (result: ExitWaitResult): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      if (onExit) {
        child.off('exit', onExit)
      }
      resolve(result)
    }

    onExit = () => finish('exit')
    child.once('exit', onExit)
    timer = setTimeout(() => finish('timeout'), timeoutMs)
  })
}

function createOverflowEvent(rootPath: string): FsChangeEvent[] {
  return [{ kind: 'overflow', absolutePath: rootPath }]
}

/** Start a file-explorer watcher in a forked Node child process while keeping
 *  the same debounce/coalesce semantics as the in-main watcher. */
export function watchFilesystemOutOfProcess(
  rootPath: string,
  ignore: string[],
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

      const nextChild = fork(getFilesystemWatcherChildPath(), [], {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1',
          [FILESYSTEM_WATCHER_CHILD_DATA_ENV]: JSON.stringify({ rootPath, ignore })
        },
        ...(process.platform === 'win32' ? { windowsHide: true } : {})
      })
      child = nextChild
      let childReady = false

      nextChild.stderr?.on('data', (chunk) => {
        console.error('[filesystem-watcher] subprocess stderr', {
          rootPath,
          message: String(chunk).trim()
        })
      })

      nextChild.on('message', (message: FilesystemWatcherChildMessage) => {
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
              console.error('[filesystem-watcher] subprocess failed before ready', {
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
          console.error('[filesystem-watcher] subprocess error', {
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
            console.error('[filesystem-watcher] subprocess failed before ready', { rootPath, err })
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
        console.error('[filesystem-watcher] subprocess failed', { rootPath, err })
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
          reject(new Error(`filesystem watcher subprocess exited before ready (code ${code})`))
          return
        }
        console.error('[filesystem-watcher] subprocess exited', { rootPath, code, signal })
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
        current.send({ type: 'unsubscribe' } satisfies FilesystemWatcherHostMessage)
      } catch {
        // Process already gone; the exit wait and timeout backstop cover it.
      }
      const exitResult = await waitForExit(current, CHILD_TEARDOWN_TIMEOUT_MS)
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
