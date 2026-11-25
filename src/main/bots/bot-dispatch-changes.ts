// Dispatch rows a trigger said changed, read once the writing transaction ends and applied, in the
// order they changed, to every bot whose chats or workers they belong to.
import type { DispatchCreatorLink } from '../runtime/orchestration/db/dispatch-context/dispatch-links-by-id'
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { DispatchRowChange } from '../runtime/orchestration/db/worker-status-notice'
import type { BotDispatchPlacement } from './bot-chat-dispatches'

export type BotDispatchChangesDeps = {
  db: () => OrchestrationDb
  /** Each kept bot's placement. */
  placements: () => Iterable<readonly [botId: string, placement: BotDispatchPlacement]>
  /** These bots' placements took a change (their bots hear of it); `unplaced`, the Dispatches that fit
   *  no kept bot (an unread bot may own them). */
  applied: (botIds: ReadonlySet<string>, unplaced: readonly string[]) => void
  /** A Dispatch's rows were removed (a reset): every base rebuilds. */
  removed: () => void
  /** The rows could not be read: every bot rebuilds and hears of it. */
  unreadable: () => void
}

export class BotDispatchChanges {
  private pending = new Set<string>()
  private removed = false
  private queued = false

  constructor(private readonly deps: BotDispatchChangesDeps) {}

  changed(dispatchId: string | null, change: DispatchRowChange): void {
    if (change === 'deleted' || dispatchId === null) {
      // A placement can't take a row away in place; a reset deletes thousands, told once per batch.
      this.removed = true
    } else {
      this.pending.add(dispatchId)
    }
    if (!this.queued) {
      this.queued = true
      queueMicrotask(() => this.flush())
    }
  }

  private flush(): void {
    this.queued = false
    const ids = [...this.pending]
    this.pending = new Set()
    if (this.removed) {
      this.removed = false
      this.deps.removed()
      return
    }
    const db = this.deps.db()
    let links: DispatchCreatorLink[]
    try {
      const byId = new Map(db.listDispatchLinksByIds(ids).map((link) => [link.id, link]))
      links = ids.flatMap((id) => byId.get(id) ?? [])
    } catch (error) {
      console.warn('[bots] could not read changed Dispatches', error)
      this.deps.unreadable()
      return
    }
    const botIds = new Set<string>()
    const unplaced: string[] = []
    for (const link of links) {
      let placed = false
      // A worker's own new Dispatch finds the worker its parent, earlier in this batch, just named.
      for (const [botId, placement] of this.deps.placements()) {
        const applied = placement.apply(db, link)
        placed ||= applied !== 'none'
        if (applied === 'changed') {
          botIds.add(botId)
        }
      }
      if (!placed) {
        unplaced.push(link.id)
      }
    }
    this.deps.applied(botIds, unplaced)
  }
}
