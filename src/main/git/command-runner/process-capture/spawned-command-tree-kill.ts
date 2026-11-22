import { spawn, type ChildProcess } from 'node:child_process'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { endAbandonedWorkerGroup } from './abandoned-worker-group-termination'
import { admitSelfInitiatedTreeKill } from '../../../pty/process-retirement/own-chromium-tree-kill-guard'
import {
  canSpawnOnWorkerThread,
  isAbandonedWorkerChildError,
  spawnProcessOnWorkerThread,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'

const WINDOWS_TREE_KILL_WAIT_MS = 2_000
const WORKER_PID_WAIT_MS = 5_000
// One tree kill per worker child: a second could walk a reused PID after the first ended the tree. True once taskkill proved the tree ended.
const workerTreeKills = new WeakMap<WorkerThreadChildProcess, Promise<boolean>>()
// Tree kills a dying worker leaves in one turn share one taskkill per host, so main pays at most one launch.
const taskkillBatches = new Map<boolean, { pids: Set<number>; ended: Promise<boolean> }>()

function batchTaskkill(pids: readonly number[], onWorker: boolean): Promise<boolean> {
  let batch = taskkillBatches.get(onWorker)
  if (!batch) {
    const collected = new Set<number>()
    const ended = new Promise<boolean>((resolve) => {
      queueMicrotask(() => {
        taskkillBatches.delete(onWorker)
        void runTaskkill([...collected], onWorker).then(resolve)
      })
    })
    batch = { pids: collected, ended }
    taskkillBatches.set(onWorker, batch)
  }
  for (const pid of pids) {
    batch.pids.add(pid)
  }
  return batch.ended
}

/** A dead worker can no longer stop its children; end a still-running Windows tree whose PID it reported. True when the tree ended or its root already had. */
export function killAbandonedWorkerChildTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<boolean> {
  const pid = child.pid
  // An exited root's pid may be reused, so it is never killed; its exit is the evidence, even after a failed earlier kill.
  if (
    process.platform !== 'win32' ||
    !pid ||
    (child.exitCode ?? null) !== null ||
    (child.signalCode ?? null) !== null
  ) {
    return Promise.resolve(true)
  }
  const started = child instanceof WorkerThreadChildProcess && workerTreeKills.get(child)
  if (started) {
    return started
  }
  if (
    !admitSelfInitiatedTreeKill({ pid, site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
  ) {
    return Promise.resolve(false)
  }
  const kill = batchTaskkill([pid], canSpawnOnWorkerThread())
  if (child instanceof WorkerThreadChildProcess) {
    workerTreeKills.set(child, kill)
  }
  return kill
}

const ABANDONED_ROOT_FIRST_CHECK_MS = 1_000
const ABANDONED_ROOT_MAX_CHECK_MS = 30_000

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
  }
}

/** Without a proven tree kill, the root's own end stands in for the close a dead worker can't deliver; a reused pid only delays it. */
export function reportWhenAbandonedRootEnds(
  pid: number | undefined,
  proven: Promise<boolean>,
  onTerminated: () => void
): void {
  void proven.then((ended) => {
    if (ended || !pid || processIsGone(pid)) {
      onTerminated()
      return
    }
    // Backs off: a root that outlives the first checks (or a reused pid) costs little while it lasts.
    const checkAfter = (delayMs: number): void => {
      setTimeout(() => {
        if (processIsGone(pid)) {
          onTerminated()
        } else {
          checkAfter(Math.min(delayMs * 2, ABANDONED_ROOT_MAX_CHECK_MS))
        }
      }, delayMs).unref?.()
    }
    checkAfter(ABANDONED_ROOT_FIRST_CHECK_MS)
  })
}

/** Capacity returns at once; termination is reported once the tree kill succeeds or the root is gone.
 * A caller whose lifetime already ends on worker loss (no mutation fence) awaits no proof. */
export function endAbandonedWorkerChild(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>,
  onWorkerLost: (() => void) | undefined,
  onTerminated: () => void,
  lifetimeEndsOnLoss = false,
  ownedPosixGroup = false
): void {
  if (ownedPosixGroup && child instanceof WorkerThreadChildProcess) {
    endAbandonedWorkerGroup(child, onWorkerLost, onTerminated, lifetimeEndsOnLoss)
    return
  }
  onWorkerLost?.()
  const killed = killAbandonedWorkerChildTree(child)
  if (lifetimeEndsOnLoss) {
    onTerminated()
    return
  }
  reportWhenAbandonedRootEnds(child.pid, killed, onTerminated)
}

/** Resolves once the stop is done; a stopped child's own close still reports its termination. */
export function killSpawnedCommandTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<void> {
  if (!(child instanceof WorkerThreadChildProcess)) {
    return startTreeKill(child).then(() => {})
  }
  // Nothing reads a child being stopped; its remaining output stays on the worker.
  child.discardOutput()
  let kill = workerTreeKills.get(child)
  if (!kill) {
    kill = startTreeKill(child)
    workerTreeKills.set(child, kill)
  }
  return kill.then(() => {})
}

/** True when taskkill proved the tree ended, or the child closed before its PID arrived. */
function startTreeKill(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<boolean> {
  const pid = child.pid
  if (!pid && process.platform === 'win32' && child instanceof WorkerThreadChildProcess) {
    return killOnceWorkerReportsPid(child)
  }
  if (!pid || process.platform !== 'win32') {
    child.kill()
    return Promise.resolve(false)
  }
  // Windows may reuse the pid after exit while inherited pipes still delay close.
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
    child.kill()
    return Promise.resolve(false)
  }
  if (
    !admitSelfInitiatedTreeKill({ pid, site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
  ) {
    // A refused PID tree walk still permits handle-based root termination without risking a reused PID.
    child.kill()
    return Promise.resolve(false)
  }
  // Await Windows tree cleanup so shim/WSL descendants cannot outlive their probe.
  return runTaskkill([pid]).then((ended) => {
    if (!ended) {
      child.kill()
    }
    return ended
  })
}

/** True when taskkill reported every tree ended within its wait. */
function runTaskkill(pids: number[], onWorker = canSpawnOnWorkerThread()): Promise<boolean> {
  return new Promise((resolve) => {
    const taskkill = windowsSystem32Binary('taskkill.exe')
    const args = [...pids.flatMap((pid) => ['/pid', String(pid)]), '/t', '/f']
    let killer: ChildProcess | WorkerThreadChildProcess
    try {
      if (onWorker) {
        // Process creation blocks its thread on Windows; keep cleanup off main like the Git it ends.
        killer = spawnProcessOnWorkerThread({ program: taskkill, args })
        killer.stdin.end()
        killer.discardOutput()
      } else {
        const native = spawn(taskkill, args, { stdio: 'ignore', windowsHide: true })
        if (!native || typeof native.unref !== 'function') {
          resolve(false)
          return
        }
        native.unref()
        killer = native
      }
    } catch {
      resolve(false)
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | null = null
    const finish = (ended: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
      }
      killer.removeAllListeners()
      resolve(ended)
    }
    killer.once('error', (error) => {
      // Only a taskkill the worker never created restarts here; one that ran may have freed the PID for reuse.
      if (onWorker && isAbandonedWorkerChildError(error) && !killer.pid && !settled) {
        settled = true
        if (timer) {
          clearTimeout(timer)
        }
        killer.removeAllListeners()
        resolve(batchTaskkill(pids, false))
        return
      }
      finish(false)
    })
    killer.once('close', (code) => finish(code === 0))
    const waitFor = (ms: number): void => {
      if (timer) {
        clearTimeout(timer)
      }
      timer = setTimeout(() => {
        killer.kill()
        finish(false)
      }, ms)
    }
    if (onWorker) {
      // As with a native launch, the wait starts once taskkill exists. A queued taskkill is never given up
      // for a root-only kill: the live worker reaches it, and a dead one reruns it from main.
      killer.once('spawn', () => waitFor(WINDOWS_TREE_KILL_WAIT_MS))
    } else {
      waitFor(WINDOWS_TREE_KILL_WAIT_MS)
    }
  })
}

/** The worker created the process but its PID is still in flight; a root-only kill would leave hooks and filters running. */
function killOnceWorkerReportsPid(child: WorkerThreadChildProcess): Promise<boolean> {
  if (child.closed) {
    return Promise.resolve(true)
  }
  // A launch still queued behind others is dropped outright; one already underway reports its PID.
  child.cancelPendingSpawn()
  return new Promise((resolve) => {
    let settled = false
    const settle = (proven: boolean): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve(proven)
      }
    }
    const detach = (): void => {
      child.off('spawn', onSpawn)
      child.off('close', onClose)
      child.off('error', onError)
    }
    // A late PID still gets the tree kill, even after the caller stopped waiting for it.
    const onSpawn = (): void => {
      detach()
      clearTimeout(timer)
      // Abandonment after a late PID waits on this kill, not on the PID wait that already gave up.
      const kill = startTreeKill(child)
      workerTreeKills.set(child, kill)
      void kill.then(settle)
    }
    const onClose = (): void => {
      detach()
      settle(true)
    }
    const onError = (error: Error): void => {
      if (isAbandonedWorkerChildError(error)) {
        onClose()
      }
    }
    // Stop waiting without a root kill: one queued behind the spawn could end the root before taskkill walks its tree.
    const timer = setTimeout(() => settle(false), WORKER_PID_WAIT_MS)
    child.on('spawn', onSpawn)
    child.on('close', onClose)
    child.on('error', onError)
  })
}
