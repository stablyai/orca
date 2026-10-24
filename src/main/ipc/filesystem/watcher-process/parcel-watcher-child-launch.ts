import { fork, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  createWatcherCanaryDirectory,
  removeWatcherCanaryDirectory
} from '../../parcel-watcher-canary-directory'
import { reserveWatcherChild, WatcherChildCapacityError } from './parcel-watcher-child-registry'
import { registerWatcherChildPhysicalExit } from './parcel-watcher-child-termination'
import type { WatcherToHostMessage } from '../../parcel-watcher-process-protocol'

export type LaunchedWatcherChild = {
  child: ChildProcess
  canaryDir: string | null
}

export function launchWatcherChild(
  entryPath: string,
  currentCanaryDir: string | null,
  onMessage: (child: ChildProcess, message: WatcherToHostMessage) => void,
  onGone: (child: ChildProcess, code?: number | null, signal?: NodeJS.Signals | null) => void
): LaunchedWatcherChild | null {
  const releaseReservation = reserveWatcherChild()
  if (!releaseReservation) {
    console.error('[parcel-watcher-process] physical watcher child limit reached')
    // Preserve transient capacity errors so callers retry instead of caching the root as unavailable.
    throw new WatcherChildCapacityError()
  }
  const canaryDir = currentCanaryDir ?? createWatcherCanaryDirectory()
  let child: ChildProcess
  try {
    child = fork(entryPath, [], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        ...(canaryDir ? { ORCA_WATCHER_CANARY_DIR: canaryDir } : {})
      },
      ...(process.platform === 'win32' ? { windowsHide: true } : {})
    })
  } catch (error) {
    releaseReservation()
    removeWatcherCanaryDirectory(canaryDir)
    console.error('[parcel-watcher-process] failed to fork watcher process:', error)
    return null
  }
  const faultHarnessPidFile = process.env.ORCA_WATCHER_CHILD_PID_FILE
  if (faultHarnessPidFile && child.pid) {
    try {
      // Exclusive creation keeps a leaked harness path from overwriting an existing file.
      writeFileSync(faultHarnessPidFile, String(child.pid), { flag: 'wx' })
    } catch {
      // Fault-injection observability must never affect watcher availability.
    }
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error('[parcel-watcher-process]', String(chunk).trimEnd())
  })
  child.on('message', (message) => onMessage(child, message as WatcherToHostMessage))
  const signalPhysicalExit = registerWatcherChildPhysicalExit(child)
  let finalized = false
  const finalizePhysicalExit = (): void => {
    if (finalized) {
      return
    }
    finalized = true
    signalPhysicalExit()
    releaseReservation()
  }
  // Recover at disconnect, before a concurrent subscribe can replace the child and lose old roots.
  child.on('disconnect', () => onGone(child))
  child.on('error', () => onGone(child))
  // Spawn failure can emit close without exit; release its physical-process reservation.
  child.once('close', finalizePhysicalExit)
  child.on('exit', (code, signal) => {
    finalizePhysicalExit()
    onGone(child, code, signal)
  })
  return { child, canaryDir }
}
