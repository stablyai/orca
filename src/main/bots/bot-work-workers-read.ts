// A bot's work rows' workers as orchestration reads them now, in one batch.
import {
  resolveWorkerLineage,
  type WorkerLineage
} from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import { readDispatchWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import { sessionWorkerIsWorking } from '../../shared/orchestration-session-workers'
import { readServerOwnedWorker } from './bot-work-server-owned-worker'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'

/** Each Dispatch's worker as its lineage's newest Dispatch, read in one batch; a server-owned one from
 *  this Orca's record of it. Null when its records are gone; left out when it can't be read. */
export async function readWorkers(
  runtime: BotWorkRuntime,
  dispatchIds: readonly string[]
): Promise<Map<string, BotWorkWorker | null>> {
  const db = runtime.getOrchestrationDb()
  // One walk per lineage, shared by links to a worker's first Dispatch and its follow-ups. Null: its
  // Task is gone.
  const lineages = new Map<string, WorkerLineage>()
  const latestOf = new Map(
    dispatchIds.flatMap((id) => {
      try {
        const latest = resolveWorkerLineage(db, id, undefined, lineages)?.latest
        return [[id, latest && (db.getTask(latest.task_id) ? latest : null)] as const]
      } catch {
        return []
      }
    })
  )
  const readable = [...new Set([...latestOf.values()].flatMap((latest) => latest?.id ?? []))]
  const workerReads = await readDispatchWorkers(runtime, readable, { lostTerminalsEnded: true })
  const reads = new Map(workerReads.map((entry) => [entry.dispatchId, entry]))
  const workers = new Map<string, BotWorkWorker | null>()
  for (const [dispatchId, latest] of latestOf) {
    if (!latest) {
      const owned =
        latest === null
          ? null
          : await readServerOwnedWorker(runtime, dispatchId).catch(() => undefined)
      if (owned !== undefined) {
        workers.set(dispatchId, owned)
      }
      continue
    }
    const read = reads.get(latest.id)
    const durable = db.getWorkerDispatch(latest.id)
    const federated = db.getFederatedDispatch(latest.id)
    workers.set(dispatchId, {
      dispatchId: latest.id,
      taskId: latest.task_id,
      title: read?.title ?? latest.task_id,
      agent: read?.agent ?? null,
      state: read?.state ?? 'unverifiable',
      idle: read ? read.state === 'working' && !sessionWorkerIsWorking(read) : false,
      stopped: durable?.state === 'stopped' || durable?.state === 'abandoned',
      // Only the start itself: a continued worker ran, whatever its newest follow-up did.
      startFailed:
        latest.id === dispatchId &&
        (read?.state ?? durable?.state) === 'failed' &&
        !durable?.agent_terminal_handle,
      host: federated?.environment_id ?? 'local',
      hostName: federated?.environment_name ?? null,
      worktreeId: read?.worktreeId ?? durable?.worktree_id ?? null,
      startedAt: read?.startedAt ?? Date.now(),
      settledAt: read?.settledAt ?? null
    })
  }
  return workers
}
