import { fork, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import {
  createWatcherCanaryDirectory,
  removeWatcherCanaryDirectory
} from './parcel-watcher-canary-directory'
import type { WatcherToHostMessage } from './parcel-watcher-process-protocol'

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
    removeWatcherCanaryDirectory(canaryDir)
    console.error('[parcel-watcher-process] failed to fork watcher process:', error)
    return null
  }
  const faultHarnessPidFile = process.env.ORCA_WATCHER_CHILD_PID_FILE
  if (faultHarnessPidFile && child.pid) {
    try {
      // Why: exclusive creation lets the harness identify the child without a
      // leaked test-only environment variable clobbering an existing file.
      writeFileSync(faultHarnessPidFile, String(child.pid), { flag: 'wx' })
    } catch {
      // Fault-injection observability must never affect watcher availability.
    }
  }
  child.stderr?.on('data', (chunk: Buffer) => {
    console.error('[parcel-watcher-process]', String(chunk).trimEnd())
  })
  child.on('message', (message) => onMessage(child, message as WatcherToHostMessage))
  // Why: Node can close IPC before emitting exit. Recover at disconnect so a
  // concurrent subscribe cannot replace the child without restoring old roots.
  child.on('disconnect', () => onGone(child))
  child.on('error', () => onGone(child))
  child.on('exit', (code, signal) => onGone(child, code, signal))
  return { child, canaryDir }
}
