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
  isAbandonedWorkerChildError,
  spawnProcessOnWorkerThread,
  spawnWorkerReadyNow
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

/** runProcess `launch` for Windows, where CreateProcessW blocks its calling thread (#27362): a plain piped spec starts on the process worker. */
export function launchProcessSpecOnWindowsWorker(
  spec: ProcessSpec,
  onWorkerLost: (() => void) | undefined,
  onTerminated: () => void,
  /** The caller holds no mutation fence: worker loss ends its lifetime without proof. */
  lifetimeEndsOnLoss = false,
  outputCapture: 'head' | 'tail' = 'head'
): LaunchedProcess | null {
  if (process.platform !== 'win32' || !canSpawnOnWorkerThread()) {
    return null
  }
  return launchProcessSpecOnWorker(
    spec,
    onWorkerLost,
    onTerminated,
    lifetimeEndsOnLoss,
    outputCapture
  )
}

/** Main's default runProcess launcher on POSIX: posix_spawn blocks its calling thread, for minutes under memory or disk pressure.
 * Specs that own a process group, termination barrier, or termination-proof callback keep their proven launch on main.
 * Uses spawnWorkerReadyNow() so a cold or broken worker falls back to main rather than rejecting early callers. */
export function launchPlainProcessSpecOnPosixWorker(
  spec: ProcessSpec,
  outputCapture: 'head' | 'tail' = 'head'
): LaunchedProcess | null {
  if (
    process.platform === 'win32' ||
    spec.terminationBarrier ||
    spec.onChildTerminated ||
    !spawnWorkerReadyNow()
  ) {
    return null
  }
  return launchProcessSpecOnWorker(spec, undefined, () => {}, true, outputCapture)
}

function launchProcessSpecOnWorker(
  spec: ProcessSpec,
  onWorkerLost: (() => void) | undefined,
  onTerminated: () => void,
  lifetimeEndsOnLoss: boolean,
  outputCapture: 'head' | 'tail'
): LaunchedProcess | null {
  if (!isPlainPiped(spec)) {
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
  // Only discard past the cap for head-captured streams with no full-stream observer.
  if (outputCapture === 'head') {
    const cap = spec.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const hasStderrObserver =
      Boolean(spec.onStderr) ||
      (typeof spec.terminationBarrier === 'object' &&
        Boolean(spec.terminationBarrier.observeStderr))
    const discardableStreams: readonly ('stdout' | 'stderr')[] = hasStderrObserver
      ? ['stdout']
      : ['stdout', 'stderr']
    for (const stream of discardableStreams) {
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
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stand-in carries the piped surface runProcess and its tree kill read: pid, exitCode, signalCode, kill, stdio streams, and spawn/error/exit/close events.
  const launched = child as unknown as ChildProcess
  child.on('error', (error) => {
    if (child.pid === undefined || !isAbandonedWorkerChildError(error)) {
      return
    }
    onWorkerLost?.()
    if (process.platform !== 'win32') {
      // Worker death closes stdio pipes (EOF/SIGPIPE); avoid SIGKILLing a pid the dead worker may already have reaped.
      if (lifetimeEndsOnLoss) {
        onTerminated()
      }
      return
    }
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
