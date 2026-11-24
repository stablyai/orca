import { spawnWorkerThread } from '../../worker-threads/worker-thread-spawn'
import {
  currentWorkerEntryLayout,
  resolveWorkerThreadEntryPath
} from '../../worker-threads/worker-thread-entry-path'
import { WorkerThreadRequestQueue } from '../../worker-threads/worker-thread-request-queue'
import type { WorkerThreadFactory } from '../../worker-threads/worker-thread-transport'
import type { RuntimeClientEvent } from '../../../shared/remote-runtime/session-graph/runtime-client-events'
import {
  PIPELINE_STORE_OPS,
  PIPELINE_TEMPLATE_OPS,
  PIPELINE_REQUEST_OPS,
  PIPELINE_DECISION_OPS,
  type PipelineStoreRemote
} from './pipeline-store-port'
import type {
  PipelineStoreWorkerRequest,
  PipelineStoreWorkerResponse
} from './pipeline-store-worker-protocol'

const spawnPipelineStoreWorker: WorkerThreadFactory = () =>
  spawnWorkerThread(
    resolveWorkerThreadEntryPath(
      currentWorkerEntryLayout(__dirname),
      'pipeline-store-worker-entry.js'
    ),
    { name: 'orca-pipeline-store' }
  )

export class PipelineStoreWorkerClient {
  private readonly queue: WorkerThreadRequestQueue<
    PipelineStoreWorkerRequest,
    PipelineStoreWorkerResponse
  >
  readonly store: PipelineStoreRemote

  constructor(
    file: string,
    publish: (event: RuntimeClientEvent) => void,
    factory = spawnPipelineStoreWorker
  ) {
    this.queue = new WorkerThreadRequestQueue({
      factory,
      idleTeardownMs: 60000,
      maxConsecutiveDeaths: 2,
      queueCap: { maxQueuedCalls: 64, describeFull: () => 'pipeline_store_queue_full' },
      awaitRetirement: true,
      createUnavailableError: () => new Error('pipeline_store_outcome_unknown'),
      describeTimeout: () => 'pipeline_store_timeout',
      describeExit: () => 'pipeline_store_worker_exited',
      describeCrashLoop: () => 'pipeline_store_worker_unavailable',
      onUnavailable: (error) => console.warn('[pipelines] Store outcome unknown:', error)
    })
    const methods = (group: PipelineStoreWorkerRequest['group'], names: readonly string[]) =>
      Object.fromEntries(
        names.map((op) => [
          op,
          async (...args: unknown[]) => {
            let response: PipelineStoreWorkerResponse
            try {
              response = await this.queue.dispatch((id) => ({ id, file, group, op, args }), 10000)
            } catch (cause) {
              throw new Error('pipeline_store_outcome_unknown', { cause })
            }
            for (const event of response.events) {
              try {
                publish(event)
              } catch {
                console.error('[pipelines] Progress notification failed after store operation')
              }
            }
            if (!response.ok) {
              throw new Error(response.error)
            }
            if (group === 'runs' && op === 'close') {
              this.queue.dispose()
            }
            return response.value
          }
        ])
      )
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each allowed op forwards the matching method's arguments and returns the worker's unchanged result.
    this.store = {
      ...methods('runs', PIPELINE_STORE_OPS),
      templatesV2: methods('templates', PIPELINE_TEMPLATE_OPS),
      ownerRequestsV2: methods('requests', PIPELINE_REQUEST_OPS),
      decisionsV2: methods('decisions', PIPELINE_DECISION_OPS)
    } as PipelineStoreRemote
  }
}
