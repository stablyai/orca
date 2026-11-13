import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { agentChatEntryOf } from '../../../../shared/agent-conversations/agent-chat-entries'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isStructuredAgentSessionStopNote } from '../../agent-session-wire/operations/structured-agent-session-command-turn'
import type { AgentSessionJournal } from '../journal-store'
import type { JournalRow } from '../durable-rows/journal-row-schema'
import { journalRowItemIds } from '../replay/journal-row-item-ids'
import { putOrdered, type OrderedTree } from '../input-order/journal-ordered-tree'
import { renderJournalStatusItem } from './journal-public-read'

/** One eligible entry's presented position. */
type Placement = { id: string; sequence: number; sequenceIndex: number }
type PlacementNode = {
  value: Placement
  height: number
  left?: PlacementNode
  right?: PlacementNode
}

const placements: OrderedTree<Placement, PlacementNode> = {
  compare: (a, b) =>
    a.sequence - b.sequence ||
    a.sequenceIndex - b.sequenceIndex ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  create: (value) => ({ value, height: 1 })
}

/** Work a scaling test can pin: initial builds and the items they read, upkeep identities, tree
 *  nodes touched by upkeep and reads, and entries read. */
export type AgentReadIndexWork = {
  builds: number
  builtItems: number
  upkeep: number
  nodes: number
  reads: number
}

const indexes = new WeakMap<AgentSessionJournal, JournalAgentReadIndex>()

/** One journal's agent-read index, built on first use. */
export function journalAgentReadIndex(journal: AgentSessionJournal): JournalAgentReadIndex {
  let index = indexes.get(journal)
  if (!index) {
    index = new JournalAgentReadIndex(journal)
    indexes.set(journal, index)
  }
  return index
}

/** The journal owner's commits update an index already in use; one never read is never built. */
export function journalAgentReadCommitted(
  journal: AgentSessionJournal,
  rows: readonly JournalRow[]
): void {
  indexes.get(journal)?.committed(rows)
}

/** Exactly the items that can currently be an `orca agent read` entry, in presented order, so a
 *  tail walks back over live entries only. Owner-held and in memory, like the newest-turn tree:
 *  built once per items map and epoch, then each committed row re-places only the identities it
 *  touches and their Stop notes. Deleted or ineligible items leave the tree. */
export class JournalAgentReadIndex {
  private source: object | null = null
  private epoch = ''
  private root: PlacementNode | undefined
  private readonly placed = new Map<string, Placement>()
  /** Interrupted-Stop notes by the turn whose state decides how they render. */
  private readonly notesByTurn = new Map<string, Set<string>>()
  private readonly turnOfNote = new Map<string, string>()
  readonly work: AgentReadIndexWork = { builds: 0, builtItems: 0, upkeep: 0, nodes: 0, reads: 0 }

  constructor(private readonly journal: AgentSessionJournal) {}

  /** Current entries, newest first, rendered as the public timeline presents them. */
  *newestFirst(): Generator<AgentJournalRenderItem> {
    this.ensureBuilt()
    const display = this.journal.queuedMessages.displayState()
    const stack: PlacementNode[] = []
    let node = this.root
    while (node || stack.length > 0) {
      while (node) {
        this.work.nodes++
        stack.push(node)
        node = node.right
      }
      const next = stack.pop()
      if (!next) {
        return
      }
      this.work.reads++
      const item = renderJournalStatusItem(display, next.value.id)
      if (item) {
        yield item
      }
      node = next.left
    }
  }

  /** Test seam: turns with dependent Stop notes, and the notes. */
  noteDependencies(): { turns: number; notes: number } {
    return { turns: this.notesByTurn.size, notes: this.turnOfNote.size }
  }

  committed(rows: readonly JournalRow[]): void {
    if (!this.current()) {
      return
    }
    const touched = new Set<string>()
    if (rows.length === 0) {
      // A metadata commit can change how pending sends present without writing a row.
      const order = this.journal.inputOrder
      for (const send of [...order.unsettledSubmissions(), ...order.sendingSubmissions()]) {
        touched.add(agentJournalSubmissionKey(send.clientMessageId))
      }
    }
    for (const row of rows) {
      if (row.kind === 'epoch') {
        this.source = null
        return
      }
      for (const id of journalRowItemIds(row, {
        canonical: this.journal.canonicalItemId,
        hasSubmission: (clientMessageId) => this.journal.submission(clientMessageId) !== undefined
      })) {
        touched.add(id)
      }
    }
    const display = this.journal.queuedMessages.displayState()
    for (const id of touched) {
      this.place(display, id)
      for (const note of this.notesByTurn.get(id) ?? []) {
        this.place(display, note)
      }
    }
  }

  private current(): boolean {
    return (
      this.source === this.journal.queuedMessages.inputState().items &&
      this.epoch === this.journal.cursor().epoch
    )
  }

  private ensureBuilt(): void {
    if (this.current()) {
      return
    }
    this.source = this.journal.queuedMessages.inputState().items
    this.epoch = this.journal.cursor().epoch
    this.root = undefined
    this.placed.clear()
    this.notesByTurn.clear()
    this.turnOfNote.clear()
    this.work.builds++
    const display = this.journal.queuedMessages.displayState()
    for (const id of display.items.keys()) {
      this.work.builtItems++
      this.place(display, id)
    }
  }

  private place(display: Parameters<typeof renderJournalStatusItem>[0], id: string): void {
    this.work.upkeep++
    this.indexNote(id, display.items.get(id))
    const item = renderJournalStatusItem(display, id)
    const next =
      item && agentChatEntryOf(item, () => false)
        ? { id, sequence: item.sequence, sequenceIndex: item.sequenceIndex ?? 0 }
        : undefined
    const prior = this.placed.get(id)
    if (prior && next && placements.compare(prior, next) === 0) {
      return
    }
    const visit = () => {
      this.work.nodes++
    }
    if (prior) {
      this.root = putOrdered(placements, this.root, prior, true, visit)
      this.placed.delete(id)
    }
    if (next) {
      this.root = putOrdered(placements, this.root, next, false, visit)
      this.placed.set(id, next)
    }
  }

  /** Keeps the turn → Stop-note map exact for one touched item. */
  private indexNote(id: string, item: AgentJournalRenderItem | undefined): void {
    const prior = this.turnOfNote.get(id)
    const turn =
      item &&
      item.body.kind === 'status' &&
      item.body.failure?.kind === 'cancelUnconfirmed' &&
      item.turnScope?.kind === 'turn' &&
      isStructuredAgentSessionStopNote(item.itemId)
        ? item.turnScope.turnItemId
        : undefined
    if (prior === turn) {
      return
    }
    if (prior) {
      const siblings = this.notesByTurn.get(prior)
      siblings?.delete(id)
      if (siblings?.size === 0) {
        this.notesByTurn.delete(prior)
      }
      this.turnOfNote.delete(id)
    }
    if (turn) {
      const notes = this.notesByTurn.get(turn) ?? new Set<string>()
      notes.add(id)
      this.notesByTurn.set(turn, notes)
      this.turnOfNote.set(id, turn)
    }
  }
}
