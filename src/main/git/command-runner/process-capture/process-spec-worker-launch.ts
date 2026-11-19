import type { ChildProcess } from 'node:child_process'
import type { LaunchedProcess, ProcessSpec } from '@orca/process-host/process-spec'
import { windowsTreeKillFor } from '@orca/process-host/windows-tree-kill'
import { recordSubprocessSpawn } from '../../../diagnostics/main-thread-churn-probe'
import {
  canSpawnOnWorkerThread,
  isAbandonedWorkerChildError,
  spawnProcessOnWorkerThread
} from '../../../worker-thread-child-process/worker-thread-child-process'
import { killAbandonedWorkerChildTree } from './spawned-command-tree-kill'

function isPlainPiped(spec: ProcessSpec): boolean {
  const { stdio } = spec
  const piped =
    stdio === undefined ||
    stdio === 'pipe' ||
    (Array.isArray(stdio) && stdio.length === 3 && stdio.every((entry) => entry === 'pipe'))
  return piped && !spec.detached && !spec.windowsVerbatimArguments && !spec.serialization
}

/** runProcess `launch` for Windows, where CreateProcessW blocks its calling thread (#27362): a plain piped spec starts on the process worker. */
export function launchProcessSpecOnWindowsWorker(
  spec: ProcessSpec,
  onWorkerLost: (() => void) | undefined,
  onTerminated: () => void
): LaunchedProcess | null {
  if (process.platform !== 'win32' || !isPlainPiped(spec) || !canSpawnOnWorkerThread()) {
    return null
  }
  const args = [...(spec.args ?? [])]
  const startedAt = performance.now()
  const child = spawnProcessOnWorkerThread({
    program: spec.program,
    args,
    cwd: spec.cwd,
    // The worker's env is a copy from its start; send main's current one.
    env: spec.env ?? process.env
  })
  recordSubprocessSpawn(spec.program, args, performance.now() - startedAt)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in carries the piped surface runProcess and its tree kill read: pid, exitCode, signalCode, kill, stdio streams, and spawn/error/exit/close events.
  const launched = child as unknown as ChildProcess
  child.on('error', (error) => {
    if (child.pid === undefined || !isAbandonedWorkerChildError(error)) {
      return
    }
    onWorkerLost?.()
    // runProcess's own stop may already be walking this tree; join its verdict rather than walk the pid again.
    const stopping = windowsTreeKillFor(launched)
    const treeEnded = stopping
      ? stopping.settled.then((verdict) => verdict === 'exited')
      : killAbandonedWorkerChildTree(child)
    const barrier = spec.terminationBarrier
    // Ending wsl.exe proves nothing about the Linux process group; only the guest barrier's kill does.
    const proven =
      typeof barrier === 'object'
        ? Promise.all([treeEnded, barrier.force(launched).catch(() => false)]).then(
            ([, guestEnded]) => guestEnded
          )
        : treeEnded
    void proven.then((ended) => {
      if (ended) {
        onTerminated()
      }
    })
  })
  return { child: launched, withdrawPendingLaunch: () => child.cancelPendingSpawn() }
}
