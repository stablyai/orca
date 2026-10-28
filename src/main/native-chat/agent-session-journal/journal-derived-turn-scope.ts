// Derive missing scopes for legacy/downgraded writers during creation-ordered replay.
// Running spans close on settlement/removal; rebuilt settled turns extend to the next root turn.

import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalItemBody,
  type AgentJournalTurnScope
} from '../../../shared/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session-context-clear'

export class JournalDerivedTurnScope {
  private openTurnItemId: string | null = null

  scopeFor(body: AgentJournalItemBody): AgentJournalTurnScope {
    return this.openTurnItemId === null || readAgentJournalTurn(body)
      ? AGENT_JOURNAL_THREAD_SCOPE
      : { kind: 'turn', turnItemId: this.openTurnItemId }
  }

  /** Observe applied changes; only session-owned turns open spans, and absent after means removal. */
  observe(
    itemId: string,
    root: boolean,
    before: AgentJournalItemBody | undefined,
    after: AgentJournalItemBody | undefined
  ): void {
    if (isAgentSessionContextClear(after)) {
      this.openTurnItemId = null
      return
    }
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
