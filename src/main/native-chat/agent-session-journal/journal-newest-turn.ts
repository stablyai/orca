import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Owned by the transaction-isolated input order; never saved beside the journal. */
export class JournalNewestTurn {
  private latest: AgentJournalRenderItem | null = null
  /** Row where the newest turn first settled as failed; zero while it has not. Each turn row
   * re-derives it from the newest outcome, and restore or removal rebuilds it. */
  private failedAt = 0

  constructor(state: JournalReducerState) {
    this.rebuild(state, state.lastSequence)
  }

  read(): AgentJournalRenderItem | null {
    return this.latest
  }

  /** Releasing Resume marks must be written after this position. */
  failure(): number {
    return this.failedAt
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    const previous = this.latest
    let removed = false
    if (row.kind === 'item' || row.kind === 'tombstone') {
      removed = this.refresh(state, row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        removed = this.refresh(state, mutation.itemId) || removed
      }
    } else {
      return
    }
    if (removed) {
      this.rebuild(state, row.seq)
    } else if (!settledFailure(this.latest)) {
      this.failedAt = 0
    } else if (!this.failedAt || previous?.itemId !== this.latest?.itemId) {
      this.failedAt = row.seq
    }
  }

  /** Only on restore/removal; streamed rows never rescan conversation history. Settlement order is
   * not saved, so a failure found here holds until a Resume written after `at`. */
  private rebuild(state: JournalReducerState, at: number): void {
    this.latest = null
    for (const item of state.items.values()) {
      this.observe(item)
    }
    this.failedAt = settledFailure(this.latest) ? at : 0
  }

  private observe(item: AgentJournalRenderItem | undefined): void {
    if (
      item &&
      (readAgentJournalTurn(item.body) || isAgentSessionContextClear(item.body)) &&
      (!this.latest || compareAgentJournalItems(item, this.latest) >= 0)
    ) {
      this.latest = item
    }
  }

  /** True when the newest item was removed or stopped being a turn. */
  private refresh(state: JournalReducerState, itemId: string): boolean {
    itemId = state.aliases.get(itemId) ?? itemId
    const item = state.items.get(itemId)
    if (
      this.latest?.itemId === itemId &&
      (!item || (!readAgentJournalTurn(item.body) && !isAgentSessionContextClear(item.body)))
    ) {
      return true
    }
    this.observe(item)
    return false
  }
}

function settledFailure(item: AgentJournalRenderItem | null): boolean {
  const turn = readAgentJournalTurn(item?.body)
  return turn?.state !== 'running' && turn?.outcome === 'failure'
}
