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
// A taskkill queued behind slow launches on the worker still ends, after this much extra time.
const WORKER_TASKKILL_LAUNCH_ALLOWANCE_MS = 30_000
// One tree kill per worker child: a second could walk a reused PID after the first ended the tree.
const workerTreeKills = new WeakMap<WorkerThreadChildProcess, Promise<void>>()
// PIDs a dying worker abandons in one turn share a taskkill, so main pays one launch per worker death.
let abandonedPids: number[] | null = null
let abandonedTreeKill: Promise<void> = Promise.resolve()

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
  if (!abandonedPids) {
    const pids: number[] = []
    abandonedPids = pids
    abandonedTreeKill = new Promise((resolve) => {
      queueMicrotask(() => {
        abandonedPids = null
        void runTaskkill(pids).then(() => resolve())
      })
    })
  }
  abandonedPids.push(pid)
  if (child instanceof WorkerThreadChildProcess) {
    workerTreeKills.set(child, abandonedTreeKill)
  }
  return abandonedTreeKill
}

export function killSpawnedCommandTree(
  child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>
): Promise<void> {
  if (!(child instanceof WorkerThreadChildProcess)) {
    return startTreeKill(child)
  }
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
        resolve(runTaskkill(pids, false))
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
      // As with a native launch, the wait starts once taskkill exists, not while it queues on the worker.
      killer.once('spawn', () => waitFor(WINDOWS_TREE_KILL_WAIT_MS))
      waitFor(WINDOWS_TREE_KILL_WAIT_MS + WORKER_TASKKILL_LAUNCH_ALLOWANCE_MS)
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
