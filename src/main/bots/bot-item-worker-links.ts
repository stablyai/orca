// Workers started for an item (`worker-start --item`), linked from orchestration's own record on each
// Dispatch change, as a write of the bot chat that started it: that chat shows the link and the move
// to In progress as its own item note. A crash between a Dispatch's commit and its link loses that
// link; the worker still reports to its chat. A follow-up stays on the link of the Dispatch it
// continues; a linked worker's change makes its item re-read. A change no item links reads one
// Dispatch row and calls no bots DB worker.
import type { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import { dispatchItemUid, lineageAncestors } from './bot-item-dispatch-facts'
import type { BotItemLinkView } from '../../shared/bots/bot-items'
import { noteBotItemWrite } from './bot-item-chat-notes'
import type { BotItemsRemote } from './bot-items-ops'
import type { TrackedBotItems } from './bot-item-dispatch-link-refs'
import type { BotItemRecord } from './bot-items-schema'

export type BotItemWorkerLinksDeps = {
  /** The active profile's store, only when its items file is open. */
  store: () => TrackedBotItems | null
  db: () => OrchestrationDb
  /** The chat that started a Dispatch: its live session and its chat id; null when unknown. */
  starter: (dispatchId: string) => { sessionId: string; chatId: string } | null
  /** An item's links as the wire shows them, which name a write's new links. */
  linksOf: (item: BotItemRecord) => Promise<readonly BotItemLinkView[] | undefined>
  sendOwedMail: () => Promise<void>
  /** These items changed; their bots' panels re-read. */
  changed: (store: BotItemsRemote, uids: readonly string[]) => Promise<void>
  warn: (error: unknown) => void
}

export class BotItemWorkerLinks {
  private changedDispatches = new Set<string>()
  private queued = false

  constructor(private readonly deps: BotItemWorkerLinksDeps) {}

  dispatchChanged(dispatchId: string): void {
    this.changedDispatches.add(dispatchId)
    if (!this.queued) {
      this.queued = true
      queueMicrotask(() => void this.flush().catch(this.deps.warn))
    }
  }

  private async flush(): Promise<void> {
    this.queued = false
    const ids = [...this.changedDispatches]
    this.changedDispatches = new Set()
    const store = this.deps.store()
    if (!store) {
      return
    }
    const db = this.deps.db()
    const lineages = new Map<string, string[]>()
    const lineageOf = (id: string): string[] => {
      let lineage = lineages.get(id)
      if (!lineage) {
        lineage = lineageAncestors(db, id)
        lineages.set(id, lineage)
      }
      return lineage
    }
    const touched: string[] = []
    for (const id of ids) {
      const uid = dispatchItemUid(db, id)
      if (uid && (await this.link(store.remote, uid, id, lineageOf(id)))) {
        touched.push(uid)
      }
    }
    // Read after the links above, whose writes drop the held set.
    const linkedRefs = await store.linkedDispatches()
    const refs =
      linkedRefs.size === 0
        ? []
        : [...new Set(ids.flatMap(lineageOf))].filter((ref) => linkedRefs.has(ref))
    const linked = refs.length > 0 ? await store.remote.linksTo('dispatch', refs) : []
    await this.deps.changed(store.remote, [...touched, ...linked.map((link) => link.itemUid)])
  }

  private async link(
    store: BotItemsRemote,
    uid: string,
    dispatchId: string,
    lineage: readonly string[]
  ): Promise<boolean> {
    const linked = await store.links(uid)
    if (linked.some((entry) => entry.kind === 'dispatch' && lineage.includes(entry.ref))) {
      return false
    }
    const starter = this.deps.starter(dispatchId)
    const eventId = await store.linkStartedWorker(uid, dispatchId, starter?.chatId ?? null)
    if (eventId === null) {
      return false
    }
    const item = starter ? await store.get(uid) : null
    if (item && starter) {
      const links = await this.deps.linksOf(item)
      await noteBotItemWrite(store, starter.sessionId, item, eventId, links)
      await this.deps.sendOwedMail()
    }
    return true
  }
}
