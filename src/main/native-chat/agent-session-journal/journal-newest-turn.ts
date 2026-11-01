import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'

/** Owned by the transaction-isolated input order; never saved beside the journal. */
export class JournalNewestTurn {
  private latest: AgentJournalRenderItem | null | undefined

  /** Rebuild once on restore/removal; streamed rows never rescan conversation history. */
  read(state: JournalReducerState): AgentJournalRenderItem | null {
    if (this.latest === undefined) {
      this.latest = null
      for (const item of state.items.values()) {
        this.observe(item)
      }
    }
    return this.latest
  }

  afterRow(state: JournalReducerState, row: JournalRow): void {
    if (row.kind === 'item' || row.kind === 'tombstone') {
      this.refresh(state, row.itemId)
    } else if (row.kind === 'lifecycle-batch') {
      for (const mutation of row.mutations) {
        this.refresh(state, mutation.itemId)
      }
    }
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

  private refresh(state: JournalReducerState, itemId: string): void {
    if (this.latest === undefined) {
      return
    }
    itemId = state.aliases.get(itemId) ?? itemId
    const item = state.items.get(itemId)
    if (
      this.latest?.itemId === itemId &&
      (!item || (!readAgentJournalTurn(item.body) && !isAgentSessionContextClear(item.body)))
    ) {
      this.latest = undefined
      return
    }
    this.observe(item)
  }
}
