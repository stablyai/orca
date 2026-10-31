// FIFO admission tracks this producer’s writes; read other writers’ facts by journal key, never copy them.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalTurnLifecycle,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { requiresTerminalSettlement } from '../agent-session-journal/journal-terminal-settlement'
import type { StructuredAgentSessionTransitionJournal } from '../agent-session-wire/structured-agent-session-transition'
import type { ProviderTimelineRowId, ProviderTimelineTurnRef } from './provider-timeline-rows'

/** Bound duplicate-close memory; older rows defer to the journal. */
const MAX_CLOSED_ITEMS = 512
/** Bound unanswered opener metadata even if the provider never opens a turn. */
const MAX_PENDING_INPUTS = 64
const MAX_PENDING_INPUT_BYTES = 64 * 1024

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export type ProviderTimelineOpenTurn = ProviderTimelineTurnRef & {
  running: AgentJournalTurnLifecycle
}

export type ProviderTimelinePendingInput = {
  userItemId: string
  requestedAt: number
  /** Absent means the next turn to open. */
  turnItemId?: string
}

export type ProviderTimelineOpenItem = {
  kind: 'item' | 'request'
  /** Request rows are chosen later by their queued write. */
  row: ProviderTimelineRowId | null
  turnItemId: string | null
  bytes: number
  /** Closed items hold no budget; reopen permits new work. */
  closed: boolean
}

export class ProviderTimelineState {
  ended = false
  open: ProviderTimelineOpenTurn | null = null
  /** Retain ended turns for trailing context facts. */
  latest: ProviderTimelineTurnRef | null = null
  /** External settlement leaves running tools for the provider’s own turn end. */
  stopped: ProviderTimelineTurnRef | null = null
  inputs: ProviderTimelinePendingInput[] = []
  /** Items use row IDs; requests use request:key across incarnations. */
  items = new Map<string, ProviderTimelineOpenItem>()
  /** Advance only on admission. */
  serial = 0

  get scope(): AgentJournalTurnScope {
    return this.open ? { kind: 'turn', turnItemId: this.open.itemId } : AGENT_JOURNAL_THREAD_SCOPE
  }

  serials(): { next(): number; commit(): void } {
    let taken = this.serial
    return {
      next: () => (taken += 1),
      commit: () => {
        this.serial = taken
      }
    }
  }

  /** Read any writer’s settlement; queued writes without rows remain open. */
  settledInJournal(key: string, journal: StructuredAgentSessionTransitionJournal): boolean {
    const entry = this.items.get(key)
    if (!entry || entry.closed || !entry.row) {
      return false
    }
    const body = journal.itemBody(entry.row.itemId)
    // Request-open may have skipped a turn already ended.
    return body === null ? entry.kind === 'request' : !requiresTerminalSettlement(body)
  }

  /** Evict oldest pending sends at the bound; later turns then use provider-owned openers. */
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

  opener(turnItemId: string): ProviderTimelinePendingInput | undefined {
    return (
      this.inputs.find((input) => input.turnItemId === turnItemId) ??
      this.inputs.find((input) => input.turnItemId === undefined)
    )
  }

  close(key: string, turnItemId: string | null): void {
    this.items.delete(key)
    this.items.set(key, { kind: 'item', row: null, turnItemId, bytes: 0, closed: true })
    const closed = [...this.items].filter(([, entry]) => entry.closed)
    for (const [oldest] of closed.slice(0, Math.max(0, closed.length - MAX_CLOSED_ITEMS))) {
      this.items.delete(oldest)
    }
  }

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

  /** Cancel prompts after external settlement; keep running work until the provider ends the turn. */
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
