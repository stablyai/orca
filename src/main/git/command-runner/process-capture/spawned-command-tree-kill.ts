import { spawn, type ChildProcess } from 'node:child_process'
import { admitSelfInitiatedTreeKill } from '../../../pty/process-retirement/own-chromium-tree-kill-guard'
import {
  canSpawnOnWorkerThread,
  isAbandonedWorkerChildError,
  spawnProcessOnWorkerThread,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'

const WINDOWS_TREE_KILL_WAIT_MS = 2_000
const WORKER_PID_WAIT_MS = 5_000
// One tree kill per worker child: a second could walk a reused PID after the first ended the tree.
const workerTreeKills = new WeakMap<WorkerThreadChildProcess, Promise<void>>()
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

/** A dead worker can no longer stop its children; end a still-running Windows tree whose PID it reported. */
export function killAbandonedWorkerChildTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<void> {
  const started = child instanceof WorkerThreadChildProcess && workerTreeKills.get(child)
  if (started) {
    return started
  }
  const pid = child.pid
  if (
    process.platform !== 'win32' ||
    !pid ||
    (child.exitCode ?? null) !== null ||
    (child.signalCode ?? null) !== null ||
    !admitSelfInitiatedTreeKill({ pid, site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
  ) {
    return Promise.resolve()
  }
  const kill = batchTaskkill([pid], canSpawnOnWorkerThread()).then(() => {})
  if (child instanceof WorkerThreadChildProcess) {
    workerTreeKills.set(child, kill)
  }
  return kill
}

export function killSpawnedCommandTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<void> {
  if (!(child instanceof WorkerThreadChildProcess)) {
    return startTreeKill(child)
  }
  // Nothing reads a child being stopped; its remaining output stays on the worker.
  child.discardOutput()
  let kill = workerTreeKills.get(child)
  if (!kill) {
    kill = startTreeKill(child)
    workerTreeKills.set(child, kill)
  }
  return kill
}

function startTreeKill(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<void> {
  const pid = child.pid
  if (!pid && process.platform === 'win32' && child instanceof WorkerThreadChildProcess) {
    return killOnceWorkerReportsPid(child)
  }
  if (!pid || process.platform !== 'win32') {
    child.kill()
    return Promise.resolve()
  }
  // Windows may reuse the pid after exit while inherited pipes still delay close.
  if ((child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null) {
    child.kill()
    return Promise.resolve()
  }
  if (
    !admitSelfInitiatedTreeKill({ pid, site: 'git-command-tree-kill', scope: 'win-taskkill-tree' })
  ) {
    // A refused PID tree walk still permits handle-based root termination without risking a reused PID.
    child.kill()
    return Promise.resolve()
  }
  // Await Windows tree cleanup so shim/WSL descendants cannot outlive their probe.
  return runTaskkill([pid]).then((ended) => {
    if (!ended) {
      child.kill()
    }
  })
}

/** True when taskkill reported every tree ended within its wait. */
function runTaskkill(pids: number[], onWorker = canSpawnOnWorkerThread()): Promise<boolean> {
  return new Promise((resolve) => {
    const args = [...pids.flatMap((pid) => ['/pid', String(pid)]), '/t', '/f']
    let killer: ChildProcess | WorkerThreadChildProcess
    try {
      if (onWorker) {
        // Process creation blocks its thread on Windows; keep cleanup off main like the Git it ends.
        killer = spawnProcessOnWorkerThread({ program: 'taskkill', args })
        killer.stdin.end()
        killer.discardOutput()
      } else {
        const native = spawn('taskkill', args, { stdio: 'ignore', windowsHide: true })
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
function killOnceWorkerReportsPid(child: WorkerThreadChildProcess): Promise<void> {
  if (child.closed) {
    return Promise.resolve()
  }
  // A launch still queued behind others is dropped outright; one already underway reports its PID.
  child.cancelPendingSpawn()
  return new Promise((resolve) => {
    let settled = false
    const settle = (): void => {
      if (!settled) {
        settled = true
        clearTimeout(timer)
        resolve()
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
      settle()
    }
    const onError = (error: Error): void => {
      if (isAbandonedWorkerChildError(error)) {
        onClose()
      }
    }
    // Stop waiting without a root kill: one queued behind the spawn could end the root before taskkill walks its tree.
    const timer = setTimeout(settle, WORKER_PID_WAIT_MS)
    child.on('spawn', onSpawn)
    child.on('close', onClose)
    child.on('error', onError)
  })
}
