import { spawnWorkerThread } from '../worker-threads/worker-thread-spawn'
import type { WorkerThreadRole } from '../worker-threads/worker-thread-roles'
import type { HostedWorkerThread } from './utility-worker-host-protocol'

export type HeavyWorkerSpawner = (
  filename: string | URL,
  options: { name: WorkerThreadRole; workerData?: unknown }
) => HostedWorkerThread

export type HeavyWorkerHost = {
  spawn: HeavyWorkerSpawner
  /** Lifts a pause left by repeated crashes. */
  retry: () => void
  /** What a paused host says, or null while it runs. */
  pauseMessage: () => string | null
}

let host: HeavyWorkerHost = {
  spawn: (filename, options) => spawnWorkerThread(filename, options),
  retry: () => undefined,
  pauseMessage: () => null
}

/** Electron main hosts these in a utility process; orcad, the AI Vault child and tests keep threads. */
export function setHeavyWorkerHost(next: HeavyWorkerHost): void {
  host = next
}

/** Workers whose input can be a whole transcript or tree: their OOM must not end the app. */
export function spawnHeavyWorker(
  filename: string | URL,
  options: { name: WorkerThreadRole; workerData?: unknown }
): HostedWorkerThread {
  return host.spawn(filename, options)
}

/** A user asked for this work: lift a pause left by repeated crashes before starting it. */
export function retryHeavyWorkers(): void {
  host.retry()
}

/** Lets a caller skip its own preparation (e.g. a `du` per worktree) for work a paused host refuses. */
export function heavyWorkersPauseMessage(): string | null {
  return host.pauseMessage()
}
