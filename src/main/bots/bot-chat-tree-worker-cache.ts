// Settled Dispatches' worker reads, kept between chat-tree refreshes so a refresh re-reads only running
// workers and Dispatches whose rows changed since. A write to any of a Dispatch's rows drops its read.
import type { OrchestrationSessionWorker } from '../../shared/orchestration-session-workers'

const SETTLED_STATES = new Set<OrchestrationSessionWorker['state']>([
  'completed',
  'failed',
  'stopped'
])

export const BOT_CHAT_TREE_WORKER_CACHE_MAX = 4096

export class BotChatTreeWorkerCache {
  private readonly workers = new Map<string, OrchestrationSessionWorker>()
  /** Bumped by every drop; a read only stores what nothing dropped while it ran. */
  private epoch = 0
  private clearedAt = 0
  private readonly droppedAt = new Map<string, number>()
  private source: unknown = null

  constructor(private readonly max = BOT_CHAT_TREE_WORKER_CACHE_MAX) {}

  /** `settled`: the Dispatches whose rows say they ended; only those are kept, once their read agrees. */
  async read(
    dispatchIds: readonly string[],
    settled: ReadonlySet<string>,
    readFresh: (dispatchIds: readonly string[]) => Promise<OrchestrationSessionWorker[]>,
    source: unknown
  ): Promise<OrchestrationSessionWorker[]> {
    if (source !== this.source) {
      this.source = source
      this.drop(null)
    }
    const kept: OrchestrationSessionWorker[] = []
    const missing: string[] = []
    for (const id of dispatchIds) {
      const worker = settled.has(id) ? this.workers.get(id) : undefined
      if (worker) {
        // Most recently used last, so the oldest falls out first.
        this.workers.delete(id)
        this.workers.set(id, worker)
        kept.push(worker)
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
          this.workers.set(id, worker)
        }
      }
      this.trim()
    }
    return [...kept, ...fresh]
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
      this.workers.clear()
      this.droppedAt.clear()
      this.clearedAt = this.epoch
      return
    }
    this.workers.delete(dispatchId)
    this.droppedAt.set(dispatchId, this.epoch)
    if (this.droppedAt.size > this.max) {
      // Older drops only guard reads that started before them; forgetting them all is as safe as a reset.
      this.droppedAt.clear()
      this.clearedAt = this.epoch
    }
  }

  get size(): number {
    return this.workers.size
  }

  private trim(): void {
    for (const id of this.workers.keys()) {
      if (this.workers.size <= this.max) {
        return
      }
      this.workers.delete(id)
    }
  }
}
