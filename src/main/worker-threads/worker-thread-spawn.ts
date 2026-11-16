import { Worker, type WorkerOptions } from 'node:worker_threads'

/** V8's default CodeRange (512 MB on x64) costs every worker ~600 MB of address space, so a few
 * workers exhaust a `ulimit -v` host (#37538). Worker JIT code stays far below this. */
export const WORKER_CODE_RANGE_MB = 64

export function spawnWorkerThread(filename: string | URL, options: WorkerOptions = {}): Worker {
  return new Worker(filename, {
    ...options,
    resourceLimits: { codeRangeSizeMb: WORKER_CODE_RANGE_MB, ...options.resourceLimits }
  })
}
