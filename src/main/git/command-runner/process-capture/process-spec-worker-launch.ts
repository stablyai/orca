import type { ChildProcess } from 'node:child_process'
import {
  DEFAULT_MAX_OUTPUT_BYTES,
  type LaunchedProcess,
  type ProcessSpec
} from '@orca/process-host/process-spec'
import { windowsTreeKillFor } from '@orca/process-host/windows-tree-kill'
import { recordSubprocessSpawn } from '../../../diagnostics/main-thread-churn-probe'
import {
  canSpawnOnWorkerThread,
  childSpawnerIsIsolated,
  isAbandonedWorkerChildError,
  spawnProcessOnWorkerThread
} from '../../../worker-thread-child-process/worker-thread-child-process'
import {
  killAbandonedWorkerChildTree,
  reportWhenAbandonedRootEnds
} from './spawned-command-tree-kill'

function isPlainPiped(spec: ProcessSpec): boolean {
  const { stdio } = spec
  const piped =
    stdio === undefined ||
    stdio === 'pipe' ||
    (Array.isArray(stdio) && stdio.length === 3 && stdio.every((entry) => entry === 'pipe'))
  return piped && !spec.detached && !spec.windowsVerbatimArguments && !spec.serialization
}

/**
 * runProcess `launch` that starts a plain piped spec on the process worker: on Windows because
 * CreateProcessW blocks its calling thread (#27362); on Linux so the child starts from a utility
 * process and holds none of main's Chromium sockets.
 */
export function launchProcessSpecOnWorker(
  spec: ProcessSpec,
  onWorkerLost: (() => void) | undefined,
  onTerminated: () => void,
  /** The caller holds no mutation fence: worker loss ends its lifetime without proof. */
  lifetimeEndsOnLoss = false,
  /** runProcess may keep the tail or watch every stderr chunk, so forward all output. */
  forwardAllOutput = false
): LaunchedProcess | null {
  const linux = process.platform === 'linux' && childSpawnerIsIsolated()
  if (
    (process.platform !== 'win32' && !linux) ||
    !isPlainPiped(spec) ||
    !canSpawnOnWorkerThread()
  ) {
    return null
  }
  // Linux: a barrier needs the child to lead its own group, as spawnProcess would start it.
  const ownsGroup = linux && spec.terminationBarrier === true
  const args = [...(spec.args ?? [])]
  const startedAt = performance.now()
  const child = spawnProcessOnWorkerThread({
    program: spec.program,
    args,
    cwd: spec.cwd,
    // The worker's env is a copy from its start; send main's current one.
    env: spec.env ?? process.env,
    ...(ownsGroup ? { terminationBarrier: true as const } : {})
  })
  recordSubprocessSpawn(spec.program, args, performance.now() - startedAt)
  // runProcess keeps the head of each stream; past the cap, the rest stays on the worker.
  const cap = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  for (const stream of forwardAllOutput ? [] : (['stdout', 'stderr'] as const)) {
    let received = 0
    const onData = (chunk: Buffer): void => {
      received += chunk.byteLength
      if (received > cap) {
        child[stream].off('data', onData)
        child.discardOutput(stream)
      }
    }
    child[stream].on('data', onData)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in carries the piped surface runProcess and its tree kill read: pid, exitCode, signalCode, kill, stdio streams, and spawn/error/exit/close events.
  const launched = child as unknown as ChildProcess
  child.on('error', (error) => {
    if (child.pid === undefined || !isAbandonedWorkerChildError(error)) {
      return
    }
    onWorkerLost?.()
    // runProcess's own stop may already be walking this tree; join its verdict rather than walk the pid again.
    const stopping = windowsTreeKillFor(launched)
    const rootExited = child.exitCode !== null || child.signalCode !== null
    const treeEnded =
      stopping && !rootExited
        ? stopping.settled.then((verdict) => verdict === 'exited')
        : killAbandonedWorkerChildTree(child)
    const barrier = spec.terminationBarrier
    // Ending wsl.exe proves nothing about the Linux process group; the guest barrier's kill does.
    const proven =
      typeof barrier === 'object'
        ? Promise.all([treeEnded, barrier.force(launched).catch(() => false)]).then(
            ([, guestEnded]) => guestEnded
          )
        : treeEnded
    if (lifetimeEndsOnLoss) {
      onTerminated()
      return
    }
    reportWhenAbandonedRootEnds(child.pid, proven, onTerminated)
  })
  return { child: launched, withdrawPendingLaunch: () => child.cancelPendingSpawn() }
}
