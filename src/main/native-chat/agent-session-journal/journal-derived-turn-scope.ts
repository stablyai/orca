// The turn scope of a row written before rows stated one: the root turn that was open when the
// row was created. Hosts now state a scope on every item they write, so this reads only legacy
// rows, and rows an older host writes into a newer journal after a downgrade. It needs no
// persisted state: the journal is replayed in full on every open, in creation order.
//
// A root turn record created running opens a span, which closes when a revision ends it or
// removes its turn body — a legacy `/compact` row was created as a running turn carrier and then
// overwritten with plain status. A turn record created already settled (rebuilt history) stays
// open until the next root turn record: that is its position within the provider's history.
// Rows created in the window between a crash and the stale-turn sweep land in the dead turn,
// which is where their position puts them too.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'

export class JournalDerivedTurnScope {
  private openTurnItemId: string | null = null

  /** The scope for a row being created now that states none. A turn record belongs to no turn. */
  scopeFor(body: AgentJournalItemBody): AgentJournalTurnScope {
    return this.openTurnItemId === null || readAgentJournalTurn(body)
      ? AGENT_JOURNAL_THREAD_SCOPE
      : { kind: 'turn', turnItemId: this.openTurnItemId }
  }

  /** Every change to an item, from any row, after it is applied. `before` is undefined when the
   *  row created the item, `after` when it removed it. Only the session's own turns open a span. */
  observe(
    itemId: string,
    root: boolean,
    before: AgentJournalItemBody | undefined,
    after: AgentJournalItemBody | undefined
  ): void {
    const turn = readAgentJournalTurn(after)
    if (before === undefined && turn && root) {
      this.openTurnItemId = itemId
      return
    }
    if (
      itemId === this.openTurnItemId &&
      readAgentJournalTurn(before)?.state === 'running' &&
      turn?.state !== 'running'
    ) {
      this.openTurnItemId = null
    }
  }
}
