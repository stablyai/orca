import {
  defaultWorkerFactory,
  WorkerThreadChildProcessHost,
  type WorkerThreadChildProcess
} from '../worker-thread-child-process/worker-thread-child-process'
import type { WorkerThreadChildSpec } from '../worker-thread-child-process/worker-thread-child-process-protocol'

let providerHost: WorkerThreadChildProcessHost | null = null
/** Agent launches get their own worker, so creating one never waits behind Git's queue. */
const providerWorker = (): WorkerThreadChildProcessHost =>
  (providerHost ??= new WorkerThreadChildProcessHost(defaultWorkerFactory))

export function spawnProcessOnProviderWorkerThread(
  spec: WorkerThreadChildSpec
): WorkerThreadChildProcess {
  return providerWorker().spawn(spec)
}

/** True when an agent launch now would reach a live provider worker. */
export function canSpawnOnProviderWorkerThread(): boolean {
  return providerWorker().available()
}
