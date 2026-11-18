import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import type { WorkerThreadRole } from '../worker-threads/worker-thread-roles'
import type { HostedWorkerThread } from './utility-worker-host-protocol'

export type HeavyWorkerSpawner = (
  filename: string | URL,
  options: { name: WorkerThreadRole; workerData?: unknown }
) => HostedWorkerThread

let spawner: HeavyWorkerSpawner = (filename, options) => spawnWorkerThread(filename, options)
let retry = (): void => undefined

/** Electron main hosts these in a utility process; orcad, the AI Vault child and tests keep threads. */
export function setHeavyWorkerSpawner(next: HeavyWorkerSpawner, nextRetry: () => void): void {
  spawner = next
  retry = nextRetry
}

/** Workers whose input can be a whole transcript or tree: their OOM must not end the app. */
export function spawnHeavyWorker(
  filename: string | URL,
  options: { name: WorkerThreadRole; workerData?: unknown }
): HostedWorkerThread {
  return spawner(filename, options)
}

/** A user asked for this work: lift a pause left by repeated crashes before starting it. */
export function retryHeavyWorkers(): void {
  retry()
}
