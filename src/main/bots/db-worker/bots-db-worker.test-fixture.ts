// The bots DB worker's real request handler behind the same asynchronous message boundary a worker
// thread has, so tests run the client, queue and SQL without building the worker bundle.
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import { inProcessWorker } from '../../worker-threads/in-process-worker.test-fixture'
import { handleBotsDbRequest } from './bots-db-worker-entry'
import type { BotsDbWorkerRequest } from './bots-db-worker-protocol'

export type InProcessWorkerControls = {
  /** Workers spawned so far. */
  readonly spawned: number
  /** The worker exits (as a crash) on these ops instead of answering. */
  crashOn: Set<string>
  /** The worker never answers these ops. */
  hangOn: Set<string>
}

export function inProcessBotsDbWorker(): {
  factory: WorkerThreadFactory
  controls: InProcessWorkerControls
} {
  const worker = inProcessWorker<BotsDbWorkerRequest>(handleBotsDbRequest)
  const crashOn = new Set<string>()
  const hangOn = new Set<string>()
  worker.controls.crashesOn = (request) => crashOn.has(request.op)
  worker.controls.hangsOn = (request) => hangOn.has(request.op)
  return {
    factory: worker.factory,
    controls: {
      get spawned() {
        return worker.controls.spawned
      },
      crashOn,
      hangOn
    }
  }
}
