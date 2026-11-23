// Settled Dispatches' worker reads, kept between chat-tree refreshes so a refresh re-reads only running
// workers and Dispatches whose rows changed since. A write to any of a Dispatch's rows drops its read.
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import type { DispatchRowChange } from '../runtime/orchestration/db/worker-status-notice'
import { SETTLED_WORKER_STATES, SettledDispatchReadCache } from './settled-dispatch-read-cache'

/** Per bot, so one bot's many chats never evict another's. */
export const BOT_CHAT_TREE_WORKER_CACHE_MAX = 4096

type CachedWorker = { worker: OrchestrationSessionWorker; evidence: string }

export type BotChatTreeWorkerRead = {
  botId: string
  dispatchIds: readonly string[]
  /** The Dispatches whose rows say they ended; only those are kept, once their read agrees. */
  settled: ReadonlySet<string>
  /** The live status a worker's read took its agent and host from; a kept read whose status since
   *  changed (a host reconnected, an agent exited) is read again. */
  evidenceOf: (worker: OrchestrationSessionWorker) => string
  /** The database the reads came from; another one drops every read. */
  source: unknown
}

export class BotChatTreeWorkerCache {
  private readonly reads: SettledDispatchReadCache<CachedWorker>

  constructor(max = BOT_CHAT_TREE_WORKER_CACHE_MAX) {
    this.reads = new SettledDispatchReadCache(max)
  }

  async read(
    request: BotChatTreeWorkerRead,
    readFresh: (dispatchIds: readonly string[]) => Promise<OrchestrationSessionWorker[]>
  ): Promise<OrchestrationSessionWorker[]> {
    const { botId, settled, evidenceOf } = request
    const started = this.reads.begin(request.source)
    const kept: OrchestrationSessionWorker[] = []
    const missing: string[] = []
    for (const id of request.dispatchIds) {
      const cached = settled.has(id) ? this.reads.get(botId, id) : undefined
      if (cached && evidenceOf(cached.worker) === cached.evidence) {
        kept.push(cached.worker)
      } else {
        missing.push(id)
      }
    }
    if (missing.length === 0) {
      return kept
    }
    const fresh = await readFresh(missing)
    for (const worker of fresh) {
      const id = worker.dispatchId
      if (settled.has(id) && SETTLED_WORKER_STATES.has(worker.state)) {
        // A copy: a clipped summary's slice would otherwise keep its whole report alive while cached.
        const value = { worker: structuredClone(worker), evidence: evidenceOf(worker) }
        this.reads.set(botId, id, value, id, new Set([id]), started)
      }
    }
    return [...kept, ...fresh]
  }

  /** Forgets the reads of bots no longer on the host. */
  keepBots(botIds: readonly string[]): void {
    this.reads.keepScopes(botIds)
  }

  rowChanged(dispatchId: string | null, change: DispatchRowChange): void {
    this.reads.rowChanged(dispatchId, change)
  }

  /** These Dispatches' rows changed; null drops every read (a reset). */
  drop(dispatchId: string | readonly string[] | null): void {
    this.reads.drop(dispatchId)
  }
}
