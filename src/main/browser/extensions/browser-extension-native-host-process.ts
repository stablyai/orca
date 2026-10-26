import { dirname } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpec } from '@orca/process-host/process-spec'
import {
  childProcessHasExited,
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { getForkedChildEntryPath } from '../../forked-child-entry-path'
import { NATIVE_HOST_ERRORS } from './browser-extension-native-host-errors'
import {
  createNativeHostMessageReader,
  encodeNativeHostMessage
} from './browser-extension-native-host-framing'

/** Chrome's EnsureProcessTerminated: a host gets this long after its stdin closes, then is killed. */
const CLOSE_GRACE_MS = 2_000
const START_TIMEOUT_MS = 15_000
const STDERR_LOG_BUDGET_BYTES = 4 * 1024

export type NativeHostLaunch = {
  /** Host name, for logs. */
  name: string
  program: string
  args: string[]
}

export type NativeHostHandlers = {
  onMessage: (json: string) => void
  /** Once, when the host side ends the channel; never after close(). */
  onClose: (error: string) => void
}

export type NativeHostConnection = {
  send: (json: string) => void
  /** Closes the pipes and kills the host if it has not exited within the grace period. */
  close: () => void
}

export type NativeHostSpawner = (spec: PipedProcessSpec) => PipedChildProcess

const liveHosts = new Set<PipedChildProcess>()

/** Quit: kill every host now; a pending grace timer would never fire. */
export function killAllNativeHosts(): void {
  for (const child of liveHosts) {
    if (process.platform === 'win32') {
      child.kill('SIGKILL')
    } else {
      void signalProcessTree(child, 'SIGKILL')
    }
  }
  liveHosts.clear()
}

function forwardStderr(name: string, child: PipedChildProcess): void {
  let budget = STDERR_LOG_BUDGET_BYTES
  child.stderr.on('data', (chunk: Buffer) => {
    if (budget <= 0) {
      return
    }
    const text = chunk.toString('utf8', 0, Math.min(chunk.length, budget)).trimEnd()
    budget -= chunk.length
    console.warn(
      `[browser-extensions] Native host ${name}: ${text}${budget <= 0 ? ' (further output dropped)' : ''}`
    )
  })
  child.stderr.on('error', () => {})
}

/** Resolves once the host process is running; rejects with Chrome's start error otherwise. */
export function startNativeHost(
  launch: NativeHostLaunch,
  handlers: NativeHostHandlers,
  spawn: NativeHostSpawner = spawnProcess
): Promise<NativeHostConnection> {
  return new Promise((resolve, reject) => {
    let child: PipedChildProcess
    const supervised = process.platform === 'win32'
    try {
      child = spawn(
        supervised
          ? {
              program: process.execPath,
              args: [
                getForkedChildEntryPath('browser-extension-native-host-supervisor-entry.js'),
                process.env.ELECTRON_RUN_AS_NODE ?? '',
                launch.program,
                ...launch.args
              ],
              cwd: dirname(launch.program),
              env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
              stdio: ['pipe', 'pipe', 'pipe', 'ipc']
            }
          : {
              program: launch.program,
              args: launch.args,
              cwd: dirname(launch.program),
              stdio: 'pipe',
              detached: true
            }
      )
    } catch (error) {
      console.warn(`[browser-extensions] Could not start native host ${launch.name}:`, error)
      reject(new Error(NATIVE_HOST_ERRORS.failedToStart))
      return
    }
    let spawned = false
    let closed = false
    let killTimer: NodeJS.Timeout | undefined
    let terminating = false
    let ready = false
    let pendingClose: string | undefined
    let startTimer: NodeJS.Timeout | undefined

    const terminate = (): void => {
      clearTimeout(killTimer)
      if (terminating) {
        return
      }
      terminating = true
      if (supervised) {
        child.kill('SIGKILL')
        liveHosts.delete(child)
      } else {
        void forceTerminateProcessTree(child).finally(() => liveHosts.delete(child))
      }
    }

    const release = (): void => {
      child.stdin.destroy()
      child.stdout.destroy()
      if (!spawned) {
        return
      }
      if (childProcessHasExited(child)) {
        terminate()
        return
      }
      killTimer = setTimeout(terminate, CLOSE_GRACE_MS)
      killTimer.unref()
    }
    const closeChannel = (error: string): void => {
      if (closed) {
        return
      }
      if (!ready) {
        pendingClose = error
        return
      }
      closed = true
      release()
      handlers.onClose(error)
    }
    const failStartup = (): void => {
      if (ready || closed) {
        return
      }
      closed = true
      clearTimeout(startTimer)
      release()
      terminate()
      reject(new Error(NATIVE_HOST_ERRORS.failedToStart))
    }
    const announceReady = (): void => {
      if (ready || closed) {
        return
      }
      ready = true
      clearTimeout(startTimer)
      resolve(connection)
      if (pendingClose) {
        closeChannel(pendingClose)
      }
    }
    const reader = createNativeHostMessageReader(handlers.onMessage, (reason) => {
      console.warn(`[browser-extensions] Native host ${launch.name} sent a bad ${reason}`)
      closeChannel(NATIVE_HOST_ERRORS.io)
    })
    const connection: NativeHostConnection = {
      send: (json) => {
        if (!closed) {
          child.stdin.write(encodeNativeHostMessage(json))
        }
      },
      close: () => {
        if (!closed) {
          closed = true
          release()
        }
      }
    }

    child.once('spawn', () => {
      spawned = true
      if (!childProcessHasExited(child)) {
        liveHosts.add(child)
      }
      if (!supervised) {
        announceReady()
      }
    })
    child.once('error', (error) => {
      if (!ready) {
        console.warn(`[browser-extensions] Could not start native host ${launch.name}:`, error)
        failStartup()
        return
      }
      closeChannel(NATIVE_HOST_ERRORS.io)
    })
    child.once('exit', terminate)
    if (supervised) {
      startTimer = setTimeout(failStartup, START_TIMEOUT_MS)
      startTimer.unref()
      child.on('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('type' in message)) {
          return
        }
        if (message.type === 'ready') {
          announceReady()
        } else if (message.type === 'error') {
          failStartup()
        }
      })
      child.once('close', failStartup)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (!closed) {
        reader.push(chunk)
      }
    })
    // Why stdout's end, not the exit event: replies written just before exit are still unread then.
    child.stdout.on('end', () => closeChannel(NATIVE_HOST_ERRORS.exited))
    child.stdout.on('error', () => closeChannel(NATIVE_HOST_ERRORS.io))
    child.stdin.on('error', () => closeChannel(NATIVE_HOST_ERRORS.io))
    forwardStderr(launch.name, child)
  })
}
