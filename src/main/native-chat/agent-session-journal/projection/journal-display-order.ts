import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { isAgentChatEntryKind } from '../../../../shared/agent-conversations/agent-chat-entries'
import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionJournal } from '../journal-store'
import { journalRowItemIds } from '../replay/journal-row-item-ids'
import type { JournalReducerState } from './journal-reducer'
import { renderJournalStatusItem } from './journal-public-read'

type Placed = { id: string; sequence: number; sequenceIndex: number; live: boolean }

const orders = new WeakMap<AgentSessionJournal, JournalDisplayOrder>()

/** One journal's agent-read order, caught up to its head. */
export function journalDisplayOrder(journal: AgentSessionJournal): JournalDisplayOrder {
  let order = orders.get(journal)
  if (!order) {
    order = new JournalDisplayOrder()
    orders.set(journal, order)
  }
  order.sync(journal)
  return order
}

/** Up to `count` items `take` accepts, oldest first, walking back from the newest agent-read
 *  candidate and rendering each by key as the public timeline does; `older`: candidates remain
 *  before them. Never renders the whole timeline. */
export function readJournalDisplayTail(
  journal: AgentSessionJournal,
  count: number,
  take: (item: AgentJournalRenderItem) => boolean
): { items: AgentJournalRenderItem[]; older: boolean } {
  const order = journalDisplayOrder(journal)
  const display = journal.queuedMessages.displayState()
  const items: AgentJournalRenderItem[] = []
  for (const id of order.newestFirst()) {
    if (items.length >= count) {
      return { items: items.toReversed(), older: true }
    }
    const item = renderJournalStatusItem(display, id)
    if (item && take(item)) {
      items.push(item)
    }
  }
  return { items: items.toReversed(), older: false }
}

/** The items an `orca agent read` entry can come from, in journal position order, so a tail read
 *  walks back from the newest instead of rendering every retained item. In memory only, like the
 *  newest-turn index: built once per items map (open, restore, epoch reset), then caught up from
 *  the journal's own rows since it last looked, touching only the items they name. */
export class JournalDisplayOrder {
  private source: Map<string, AgentJournalRenderItem> | null = null
  private through: AgentJournalCursor | null = null
  private order: Placed[] = []
  private readonly placed = new Map<string, Placed>()
  private dead = 0
  /** Index entries visited by reads and upkeep; scaling tests pin how this grows. */
  visits = 0

  /** Catches up to the journal's head: a new items map, epoch or unreadable gap rebuilds. */
  sync(journal: AgentSessionJournal): void {
    const state = journal.queuedMessages.inputState()
    const head = journal.cursor()
    if (this.source !== state.items || this.through?.epoch !== head.epoch) {
      this.build(state, head)
      return
    }
    if (this.through.sequence === head.sequence) {
      return
    }
    const since = journal.readSince(this.through, undefined)
    if (!since.ok) {
      this.build(state, head)
      return
    }
    for (const row of since.rows) {
      for (const id of journalRowItemIds(row, {
        canonical: (itemId) => state.aliases.get(itemId) ?? itemId,
        hasSubmission: (clientMessageId) => state.submissions.has(clientMessageId)
      })) {
        this.place(state, id)
      }
    }
    this.through = head
    if (this.dead > 64 && this.dead * 2 > this.order.length) {
      this.order = this.order.filter((entry) => entry.live)
      this.dead = 0
    }
  }

  /** Candidate item ids, newest first. */
  *newestFirst(): Generator<string> {
    for (let index = this.order.length - 1; index >= 0; index--) {
      this.visits++
      const entry = this.order[index]
      if (entry?.live) {
        yield entry.id
      }
    }
  }

  private build(state: JournalReducerState, head: AgentJournalCursor): void {
    this.source = state.items
    this.through = head
    this.placed.clear()
    this.order = []
    this.dead = 0
    for (const item of state.items.values()) {
      if (isAgentChatEntryKind(item)) {
        const entry = placedOf(item)
        this.placed.set(item.itemId, entry)
        this.order.push(entry)
      }
    }
    this.order.sort(comparePlaced)
  }

  private place(state: JournalReducerState, id: string): void {
    this.visits++
    const item = state.items.get(id)
    const prior = this.placed.get(id)
    const next = item && isAgentChatEntryKind(item) ? placedOf(item) : null
    if (prior && next && comparePlaced(prior, next) === 0) {
      return
    }
    if (prior) {
      prior.live = false
      this.dead++
      this.placed.delete(id)
    }
    if (!next) {
      return
    }
    this.placed.set(id, next)
    const last = this.order.at(-1)
    if (!last || comparePlaced(last, next) < 0) {
      this.order.push(next)
      return
    }
    let low = 0
    let high = this.order.length
    while (low < high) {
      const middle = (low + high) >> 1
      this.visits++
      const probe = this.order[middle]
      if (probe && comparePlaced(probe, next) < 0) {
        low = middle + 1
      } else {
        high = middle
      }
    }
    this.order.splice(low, 0, next)
  }
}

function placedOf(item: AgentJournalRenderItem): Placed {
  return {
    id: item.itemId,
    sequence: item.sequence,
    sequenceIndex: item.sequenceIndex ?? 0,
    live: true
  }
}

function comparePlaced(a: Placed, b: Placed): number {
  return a.sequence - b.sequence || a.sequenceIndex - b.sequenceIndex
}
