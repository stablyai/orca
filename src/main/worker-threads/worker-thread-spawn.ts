import { Worker, type WorkerOptions } from 'node:worker_threads'
import { ensureWorkerSendLedger, releaseWorkerSendLedgerSlot } from './worker-send-ledger'
import type { WorkerThreadRole } from './worker-thread-roles'

/** V8's default CodeRange (512 MB on x64) costs every worker ~600 MB of address space, so a few
 * workers exhaust a `ulimit -v` host (#37538). Worker JIT code stays far below this. */
export const WORKER_CODE_RANGE_MB = 64
/** Cap worker young generation (2x semi-space) so idle/short-lived workers don't retain 32-64 MiB. */
export const WORKER_MAX_YOUNG_GENERATION_MB = 8

export type WorkerThreadObserver = {
  /** Runs before construction: a worker copies environment data when it is created. */
  beforeSpawn: () => void
  spawned: (worker: Worker, role: WorkerThreadRole) => void
}

let observer: WorkerThreadObserver | undefined
/** Thread id per spawned worker; owners may strip every listener (removeAllListeners). */
const spawned = new Map<Worker, number>()

/** Main-process diagnostics watch every worker without this module importing them. */
export function observeWorkerThreads(next: WorkerThreadObserver): void {
  observer = next
}

/** Node sets threadId to -1 once the thread is gone, whatever listeners remain. */
function releaseExitedWorkers(): void {
  for (const [worker, threadId] of spawned) {
    if (worker.threadId === -1) {
      spawned.delete(worker)
      releaseWorkerSendLedgerSlot(threadId)
    }
  }
}

export function spawnWorkerThread(
  filename: string | URL,
  options: WorkerOptions & { name: WorkerThreadRole }
): Worker {
  releaseExitedWorkers()
  ensureWorkerSendLedger()
  try {
    observer?.beforeSpawn()
  } catch {
    // Diagnostics never fail a spawn.
  }
  const worker = new Worker(filename, {
    ...options,
    resourceLimits: {
      codeRangeSizeMb: WORKER_CODE_RANGE_MB,
      maxYoungGenerationSizeMb: WORKER_MAX_YOUNG_GENERATION_MB,
      ...options.resourceLimits
    }
  })
  spawned.set(worker, worker.threadId)
  try {
    observer?.spawned(worker, options.name)
  } catch {
    // Diagnostics never fail a spawn.
  }
  // After the observer's listeners, so a failure report still reads this worker's ledger entry.
  worker.once('exit', releaseExitedWorkers)
  return worker
}
