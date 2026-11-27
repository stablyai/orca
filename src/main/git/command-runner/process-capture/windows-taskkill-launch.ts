import { spawn, type ChildProcess } from 'node:child_process'
import { windowsSystem32Binary } from '@orca/process-host/windows-system-binary'
import { childProcessHasExited } from '@orca/process-host/process-tree-termination'
import {
  canSpawnOnWorkerThread,
  isAbandonedWorkerChildError,
  spawnProcessOnWorkerThread,
  WorkerThreadChildProcess
} from '../../../worker-thread-child-process/worker-thread-child-process'

const WINDOWS_TREE_KILL_WAIT_MS = 2_000

// Tree kills a dying worker leaves in one turn share one taskkill per host and wait, so main pays at most one launch.
type TaskkillBatchEntry = { pids: readonly number[]; root?: TaskkillRoot }
type TaskkillBatchRun = { ran: ReadonlySet<TaskkillBatchEntry>; ended: boolean }
const taskkillBatches = new Map<
  string,
  { entries: TaskkillBatchEntry[]; run: Promise<TaskkillBatchRun> }
>()

/** The root whose tree a taskkill ends; once it exits, its pid may name another process. */
export type TaskkillRoot = Pick<ChildProcess, 'exitCode' | 'signalCode'> & {
  once(event: 'exit', listener: () => void): unknown
  off(event: 'exit', listener: () => void): unknown
}

export function batchTaskkill(
  pids: readonly number[],
  onWorker: boolean,
  waitMs = WINDOWS_TREE_KILL_WAIT_MS,
  root?: TaskkillRoot
): Promise<boolean> {
  const key = `${onWorker}:${waitMs}`
  let batch = taskkillBatches.get(key)
  if (!batch) {
    const entries: TaskkillBatchEntry[] = []
    const run = new Promise<TaskkillBatchRun>((resolve) => {
      queueMicrotask(() => {
        taskkillBatches.delete(key)
        // A root that exited while batched may have freed its pid for reuse; it is dropped, not walked.
        const ran = new Set(
          entries.filter((entry) => !entry.root || !childProcessHasExited(entry.root))
        )
        if (ran.size === 0) {
          resolve({ ran, ended: false })
          return
        }
        const batched = new Set([...ran].flatMap((entry) => entry.pids))
        void runTaskkill([...batched], onWorker, waitMs).then((ended) => resolve({ ran, ended }))
      })
    })
    batch = { entries, run }
    taskkillBatches.set(key, batch)
  }
  const entry: TaskkillBatchEntry = { pids, root }
  batch.entries.push(entry)
  return batch.run.then(({ ran, ended }) => ended && ran.has(entry))
}

/** Taskkill for live pid trees outside Git. One bound to its root's handle may queue on the process worker, which withdraws it
 * if the root exits first; a pid-only kill starts inline, since nothing could recheck its pid after a queue wait. */
export function runWindowsTaskkill(
  pids: number[],
  waitMs: number,
  root?: TaskkillRoot
): Promise<boolean> {
  return runTaskkill(pids, root !== undefined && canSpawnOnWorkerThread(), waitMs, root)
}

/** True when taskkill reported every tree ended within its wait. Never started once `root` has exited. */
export function runTaskkill(
  pids: number[],
  onWorker = canSpawnOnWorkerThread(),
  waitMs = WINDOWS_TREE_KILL_WAIT_MS,
  root?: TaskkillRoot
): Promise<boolean> {
  return new Promise((resolve) => {
    if (root && childProcessHasExited(root)) {
      resolve(false)
      return
    }
    const taskkill = windowsSystem32Binary('taskkill.exe')
    const args = [...pids.flatMap((pid) => ['/pid', String(pid)]), '/t', '/f']
    let killer: ChildProcess | WorkerThreadChildProcess
    // Read by the worker as it dequeues the launch, ahead of any cancel still in flight.
    const withdrawWhenSet = onWorker && root ? new Int32Array(new SharedArrayBuffer(4)) : undefined
    try {
      if (onWorker) {
        // Process creation blocks its thread on Windows; keep cleanup off main like the Git it ends.
        killer = spawnProcessOnWorkerThread({ program: taskkill, args, withdrawWhenSet })
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
    // A queued taskkill whose root exits is withdrawn: by its turn, the root's pid may name another process.
    const withdraw = (): void => {
      if (withdrawWhenSet) {
        Atomics.store(withdrawWhenSet, 0, 1)
      }
      if (killer instanceof WorkerThreadChildProcess && killer.pid === undefined) {
        killer.cancelPendingSpawn()
      }
    }
    const detach = (): void => {
      if (timer) {
        clearTimeout(timer)
      }
      root?.off('exit', withdraw)
      killer.removeAllListeners()
    }
    const finish = (ended: boolean): void => {
      if (!settled) {
        settled = true
        detach()
        resolve(ended)
      }
    }
    if (onWorker) {
      root?.once('exit', withdraw)
    }
    killer.once('error', (error) => {
      // Only a taskkill the worker never created restarts here; one that ran may have freed the PID for reuse.
      if (onWorker && isAbandonedWorkerChildError(error) && !killer.pid && !settled) {
        if (root && childProcessHasExited(root)) {
          finish(false)
          return
        }
        settled = true
        detach()
        resolve(batchTaskkill(pids, false, waitMs, root))
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
      killer.once('spawn', () => waitFor(waitMs))
    } else {
      waitFor(waitMs)
    }
  })
}
