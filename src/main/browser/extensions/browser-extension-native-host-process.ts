import { dirname } from 'node:path'
import { spawnProcess } from '@orca/process-host'
import type { PipedChildProcess, PipedProcessSpec } from '@orca/process-host/process-spec'
import {
  childProcessHasExited,
  forceTerminateProcessTree,
  signalProcessTree
} from '@orca/process-host/process-tree-termination'
import { NATIVE_HOST_ERRORS } from './browser-extension-native-host-errors'
import {
  createNativeHostMessageReader,
  encodeNativeHostMessage
} from './browser-extension-native-host-framing'

/** Chrome's EnsureProcessTerminated: a host gets this long after its stdin closes, then is killed. */
const CLOSE_GRACE_MS = 2_000
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
    void signalProcessTree(child, 'SIGKILL')
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
    try {
      child = spawn({
        program: launch.program,
        args: launch.args,
        cwd: dirname(launch.program),
        stdio: 'pipe',
        // Why: its own POSIX group lets close() kill helpers the host started too.
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      console.warn(`[browser-extensions] Could not start native host ${launch.name}:`, error)
      reject(new Error(NATIVE_HOST_ERRORS.failedToStart))
      return
    }
    let spawned = false
    let closed = false
    let killTimer: NodeJS.Timeout | undefined

    const release = (): void => {
      child.stdin.destroy()
      child.stdout.destroy()
      if (!spawned || childProcessHasExited(child)) {
        return
      }
      killTimer = setTimeout(() => {
        if (!childProcessHasExited(child)) {
          void forceTerminateProcessTree(child)
        }
      }, CLOSE_GRACE_MS)
      killTimer.unref()
    }
    const closeChannel = (error: string): void => {
      if (closed) {
        return
      }
      closed = true
      release()
      handlers.onClose(error)
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
      resolve(connection)
    })
    child.once('error', (error) => {
      if (spawned) {
        closeChannel(NATIVE_HOST_ERRORS.io)
        return
      }
      closed = true
      console.warn(`[browser-extensions] Could not start native host ${launch.name}:`, error)
      reject(new Error(NATIVE_HOST_ERRORS.failedToStart))
    })
    child.once('exit', () => {
      clearTimeout(killTimer)
      liveHosts.delete(child)
    })
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
