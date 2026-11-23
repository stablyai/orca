// A bot's work rows' workers as orchestration reads them now, in one batch.
import {
  getFollowUpDispatch,
  resolveWorkerLineage,
  type WorkerLineage,
  type WorkerLineageReader
} from '../runtime/orchestration/db/dispatch-context/worker-follow-up-lineage'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { DispatchContextRow } from '../runtime/orchestration/db/orchestration-records'
import { readDispatchWorkers } from '../runtime/rpc/methods/orchestration/worker/session-workers-method'
import {
  sessionWorkerIsWorking,
  type OrchestrationSessionWorker
} from '../../shared/orchestration-session-workers'
import { readServerOwnedWorker } from './bot-work-server-owned-worker'
import type { BotWorkRuntime } from './bot-work-runtime'
import type { BotWorkWorker } from './bot-work-types'

/** What a read rested on, for a caller that keeps reads until those rows change. */
export type WorkerReadTrace = {
  /** Each read Dispatch's walked Dispatches: a write to any of them can change its worker. */
  walked: Map<string, ReadonlySet<string>>
  /** Each read Dispatch's newest Dispatch row. */
  latest: Map<string, DispatchContextRow>
  /** Orchestration's read of each worker, by its newest Dispatch. */
  sessions: Map<string, OrchestrationSessionWorker>
}

/** Each Dispatch's worker as its lineage's newest Dispatch, read in one batch; a server-owned one from
 *  this Orca's record of it. Null when its records are gone; left out when it can't be read. */
export async function readWorkers(
  runtime: BotWorkRuntime,
  dispatchIds: readonly string[],
  trace?: WorkerReadTrace
): Promise<Map<string, BotWorkWorker | null>> {
  const db = runtime.getOrchestrationDb()
  // One walk per lineage, shared by links to a worker's first Dispatch and its follow-ups. Null: its
  // Task is gone.
  const walks = trace ? new WalkedLineages(db) : null
  const lineages = walks ?? new Map<string, WorkerLineage>()
  const latestOf = new Map(
    dispatchIds.flatMap((id) => {
      try {
        const walked = walks?.walk()
        const latest = walks
          ? resolveWorkerLineage(walks.reader, id, walks.followUp, lineages)?.latest
          : resolveWorkerLineage(db, id, undefined, lineages)?.latest
        if (walked && latest) {
          trace?.walked.set(id, walked)
          trace?.latest.set(id, latest)
        }
        return [[id, latest && (db.getTask(latest.task_id) ? latest : null)] as const]
      } catch {
        return []
      }
    })
  )
  const readable = [...new Set([...latestOf.values()].flatMap((latest) => latest?.id ?? []))]
  const workerReads = await readDispatchWorkers(runtime, readable, { lostTerminalsEnded: true })
  const reads = new Map(workerReads.map((entry) => [entry.dispatchId, entry]))
  for (const read of workerReads) {
    trace?.sessions.set(read.dispatchId, read)
  }
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

/** A batch's lineage walks, each recording the Dispatches it read; a walk that reuses another's
 *  suffix rests on that walk's Dispatches too. */
class WalkedLineages extends Map<string, WorkerLineage> {
  private current = new Set<string>()
  private readonly walkOf = new Map<string, Set<string>>()
  readonly reader: WorkerLineageReader
  readonly followUp: (id: string) => DispatchContextRow | undefined

  constructor(db: OrchestrationDb) {
    super()
    const note = (id: string): string => {
      this.current.add(id)
      return id
    }
    this.reader = {
      db: db.db,
      getDispatchContextById: (id) => db.getDispatchContextById(note(id)),
      getWorkerTerminalResourceByOwner: (id) => db.getWorkerTerminalResourceByOwner(note(id)),
      getWorkerTerminalResourceFormerlyOwnedBy: (id) => {
        const resource = db.getWorkerTerminalResourceFormerlyOwnedBy(note(id))
        if (resource) {
          note(resource.owner_dispatch_id)
        }
        return resource
      }
    }
    this.followUp = (id) => getFollowUpDispatch(db, note(id))
  }

  /** Starts the next walk; the set fills as it reads. */
  walk(): Set<string> {
    this.current = new Set()
    return this.current
  }

  override get(id: string): WorkerLineage | undefined {
    const lineage = super.get(id)
    if (lineage) {
      for (const walked of this.walkOf.get(id) ?? []) {
        this.current.add(walked)
      }
    }
    return lineage
  }

  override set(id: string, lineage: WorkerLineage): this {
    this.walkOf.set(id, this.current)
    return super.set(id, lineage)
  }
}
