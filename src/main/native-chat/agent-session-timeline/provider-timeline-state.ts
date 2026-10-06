// What the assembler knows about the session: one state, in admission order.
//
// An event changes it only when the sink admits the event, so a refused event changed nothing and
// re-applying it is the retry. For this producer's own rows admission order is write order (the
// sink is a FIFO queue), so the state never has to be re-read from the journal. Facts other
// writers own (a person's Stop, a client's answer) are read from the journal by key, never copied.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { requiresTerminalSettlement } from '../agent-session-journal/journal-terminal-settlement'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineRowId, ProviderTimelineTurnRef } from './provider-timeline-rows'

/** Closed items remembered so a repeat close is dropped; past this the journal decides alone. */
const MAX_CLOSED_ITEMS = 512
/** Sends waiting for a turn; a provider that never opens one cannot grow this without bound. */
const MAX_PENDING_INPUTS = 64
const MAX_PENDING_INPUT_BYTES = 64 * 1024

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export type ProviderTimelineOpenTurn = ProviderTimelineTurnRef & {
  running: AgentJournalTurnLifecycle
}

/** Orca's send, waiting for the turn it opens. */
export type ProviderTimelinePendingInput = {
  userItemId: string
  requestedAt: number
  /** The turn row the provider said it opens; absent: the next turn to open. */
  turnItemId?: string
}

/** Work this acquisition holds open (a running tool, a pending request), or an item it closed. */
export type ProviderTimelineOpenItem = {
  kind: 'item' | 'request'
  /** The row; a request's is chosen by its write, which records it here. */
  row: ProviderTimelineRowId | null
  /** The turn whose end settles it; null for a row in no turn. */
  turnItemId: string | null
  bytes: number
  /** Closed here: holds no budget; a repeat close is dropped and an open reopens it. */
  closed: boolean
}

export class ProviderTimelineState {
  ended = false
  open: ProviderTimelineOpenTurn | null = null
  /** The turn that ended last, for context facts that arrive after it. */
  latest: ProviderTimelineTurnRef | null = null
  /** The turn another writer settled (a person's Stop) that the provider has not ended yet: its
   *  running work is the provider's until then. */
  stopped: ProviderTimelineTurnRef | null = null
  inputs: ProviderTimelinePendingInput[] = []
  /** Keyed by row id (an item) or `request:<key>` (a request, whatever its incarnation). */
  items = new Map<string, ProviderTimelineOpenItem>()
  /** Minted keys and settlement ids; taken only by admitted events. */
  serial = 0

  get scope(): AgentJournalTurnScope {
    return this.open ? { kind: 'turn', turnItemId: this.open.itemId } : AGENT_JOURNAL_THREAD_SCOPE
  }

  /** Serials for one event: committed with it, so a refused event takes none. */
  serials(): { next(): number; commit(): void } {
    let taken = this.serial
    return {
      next: () => (taken += 1),
      commit: () => {
        this.serial = taken
      }
    }
  }

  /** Whether the journal shows the work under `key` settled by any writer (a client's answer).
   *  Work whose write is still queued stays open. */
  settledInJournal(key: string, journal: StructuredAgentSessionTransitionJournal): boolean {
    const entry = this.items.get(key)
    if (!entry || entry.closed || !entry.row) {
      return false
    }
    const body = journal.itemBody(entry.row.itemId)
    // A request write that found its turn over left no row: nothing is pending.
    return body === null ? entry.kind === 'request' : !requiresTerminalSettlement(body)
  }

  /** A user message waiting for its turn; past the bounds the oldest is forgotten (its turn opens
   *  as the provider's own). */
  wait(pending: ProviderTimelinePendingInput): void {
    this.inputs.push(pending)
    const size = (input: ProviderTimelinePendingInput) =>
      bytes(input.userItemId) + bytes(input.turnItemId ?? '') + 16
    let held = this.inputs.reduce((total, input) => total + size(input), 0)
    while (this.inputs.length > MAX_PENDING_INPUTS || held > MAX_PENDING_INPUT_BYTES) {
      const forgotten = this.inputs.shift()
      if (!forgotten) {
        return
      }
      held -= size(forgotten)
    }
  }

  /** The message that opens `turnItemId`: the one that named it, else the oldest that named none. */
  opener(turnItemId: string): ProviderTimelinePendingInput | undefined {
    return (
      this.inputs.find((input) => input.turnItemId === turnItemId) ??
      this.inputs.find((input) => input.turnItemId === undefined)
    )
  }

  /** Closed here, in the turn it joined; past the bound the oldest closed items are forgotten. */
  close(key: string, turnItemId: string | null): void {
    this.items.delete(key)
    this.items.set(key, { kind: 'item', row: null, turnItemId, bytes: 0, closed: true })
    const closed = [...this.items].filter(([, entry]) => entry.closed)
    for (const [oldest] of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_ITEMS))) {
      this.items.delete(oldest)
    }
  }

  /** The turn is over, and so is everything in it: its end settled that work. */
  endTurn(turn: ProviderTimelineTurnRef): void {
    if (this.open?.itemId === turn.itemId) {
      this.open = null
      this.latest = turn
    }
    if (this.stopped?.itemId === turn.itemId) {
      this.stopped = null
    }
    this.forget(turn, () => true)
  }

  /** Another writer settled the open turn: it is over here and its prompts were cancelled with it,
   *  but its running work stays open until the provider ends the turn. */
  stopTurn(turn: ProviderTimelineTurnRef): void {
    if (this.open?.itemId === turn.itemId) {
      this.open = null
      this.latest = turn
      this.stopped = turn
    }
    this.forget(turn, (entry) => entry.kind === 'request')
  }

  endSession(): void {
    this.ended = true
    this.open = null
    this.stopped = null
    this.items.clear()
  }

  private forget(
    turn: ProviderTimelineTurnRef,
    which: (entry: ProviderTimelineOpenItem) => boolean
  ): void {
    for (const [key, entry] of this.items) {
      if (entry.turnItemId === turn.itemId && which(entry)) {
        this.items.delete(key)
      }
    }
  }
}
