// Settled Dispatches' worker reads, kept between chat-tree refreshes so a refresh re-reads only running
// workers and Dispatches whose rows changed since. A write to any of a Dispatch's rows drops its read.
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'
import type { DispatchRowChange } from '../runtime/orchestration/db/worker-status-notice'

const SETTLED_STATES = new Set<OrchestrationSessionWorker['state']>([
  'completed',
  'failed',
  'stopped'
])

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
  private readonly byBot = new Map<string, Map<string, CachedWorker>>()
  /** Bumped by every drop; a read only stores what nothing dropped while it ran. */
  private epoch = 0
  private clearedAt = 0
  private readonly droppedAt = new Map<string, number>()
  private source: unknown = null

  constructor(private readonly max = BOT_CHAT_TREE_WORKER_CACHE_MAX) {}

  async read(
    request: BotChatTreeWorkerRead,
    readFresh: (dispatchIds: readonly string[]) => Promise<OrchestrationSessionWorker[]>
  ): Promise<OrchestrationSessionWorker[]> {
    const { settled, evidenceOf } = request
    if (request.source !== this.source) {
      this.source = request.source
      this.drop(null)
    }
    let workers = this.byBot.get(request.botId)
    if (!workers) {
      workers = new Map()
      this.byBot.set(request.botId, workers)
    }
    const kept: OrchestrationSessionWorker[] = []
    const missing: string[] = []
    for (const id of request.dispatchIds) {
      const cached = settled.has(id) ? workers.get(id) : undefined
      if (cached && evidenceOf(cached.worker) === cached.evidence) {
        // Most recently used last, so the oldest falls out first.
        workers.delete(id)
        workers.set(id, cached)
        kept.push(cached.worker)
      } else {
        missing.push(id)
      }
    }
    if (missing.length === 0) {
      return kept
    }
    const started = this.epoch
    const fresh = await readFresh(missing)
    if (this.clearedAt <= started) {
      for (const worker of fresh) {
        const id = worker.dispatchId
        if (
          settled.has(id) &&
          SETTLED_STATES.has(worker.state) &&
          (this.droppedAt.get(id) ?? 0) <= started
        ) {
          // A copy: a clipped summary's slice would otherwise keep its whole report alive while cached.
          workers.set(id, { worker: structuredClone(worker), evidence: evidenceOf(worker) })
        }
      }
      trim(workers, this.max)
    }
    return [...kept, ...fresh]
  }

  /** Forgets the reads of bots no longer on the host. */
  keepBots(botIds: readonly string[]): void {
    const live = new Set(botIds)
    for (const botId of this.byBot.keys()) {
      if (!live.has(botId)) {
        this.byBot.delete(botId)
      }
    }
  }

  /** The database's notice of a Dispatch row write; one to a row no Dispatch owns changes no read. */
  rowChanged(dispatchId: string | null, change: DispatchRowChange): void {
    if (dispatchId !== null || change === 'deleted') {
      this.drop(dispatchId)
    }
  }

  /** These Dispatches' rows changed; null drops every read (a reset). */
  drop(dispatchId: string | readonly string[] | null): void {
    if (dispatchId !== null && typeof dispatchId !== 'string') {
      for (const id of dispatchId) {
        this.drop(id)
      }
      return
    }
    this.epoch += 1
    if (dispatchId === null) {
      this.byBot.clear()
      this.droppedAt.clear()
      this.clearedAt = this.epoch
      return
    }
    for (const workers of this.byBot.values()) {
      workers.delete(dispatchId)
    }
    this.droppedAt.set(dispatchId, this.epoch)
    if (this.droppedAt.size > this.max) {
      // Older drops only guard reads that started before them; forgetting them all is as safe as a reset.
      this.droppedAt.clear()
      this.clearedAt = this.epoch
    }
  }
}

function trim(workers: Map<string, CachedWorker>, max: number): void {
  for (const id of workers.keys()) {
    if (workers.size <= max) {
      return
    }
    workers.delete(id)
  }
}
