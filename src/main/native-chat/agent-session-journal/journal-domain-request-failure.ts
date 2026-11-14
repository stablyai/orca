import type Database from '../../sqlite/sync-database'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentTurnVerdict } from '../../../shared/agent-status/lifecycle/agent-turn-outcome'
import {
  readAgentJournalTurn,
  readAgentJournalTurnOutcome
} from '../../../shared/agent-session/lifecycle/records/agent-session-turn-record'
import {
  isStructuredAgentSessionCommandTurn,
  isStructuredAgentSessionCommandEntry
} from '../../../shared/agent-session/structured-agent-session-command-entry'
import { classifyDispatchRejection } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import { journalDomainInputForItem, journalDomainSubmission } from './journal-domain-status-inputs'
import {
  journalDomainLatestStop,
  journalDomainStopDecidesTurn
} from './journal-domain-item-normalization'
import { JournalSqlScope } from './journal-sql-scope'
import type { JournalRequestMark } from './journal-request-failure'
import type { JournalStopSettleFact } from './journal-writer-host-facts'

export class JournalDomainRequestFailure {
  private readonly scope: JournalSqlScope
  readonly floor: number

  constructor(
    db: Database.Database,
    target: { sessionId: string; epoch: string },
    private readonly stopSettle?: JournalStopSettleFact
  ) {
    this.scope = new JournalSqlScope(db, target.sessionId, target.epoch)
    this.floor = Number(
      db
        .prepare(`SELECT MAX(sequence) AS sequence FROM journal_items
      WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1`)
        .get(...this.scope.prefix)?.sequence ?? 0
    )
  }

  canonical(id: string): string {
    const row = this.scope.db
      .prepare(`SELECT item_id FROM journal_item_aliases
      WHERE session_id=? AND epoch=? AND provider_item_id=?`)
      .get(...this.scope.prefix, id)
    return row ? String(row.item_id) : id
  }

  private row(id: string) {
    return this.scope.db
      .prepare(`SELECT payload_json,root,COALESCE(execution_owner,owner_fence) AS fence
      FROM journal_items WHERE session_id=? AND epoch=? AND hidden=0 AND item_id=?`)
      .get(...this.scope.prefix, id)
  }

  item(id: string): AgentJournalRenderItem | null {
    const row = this.row(id)
    return row ? JSON.parse(String(row.payload_json)) : null
  }

  request(kind: JournalRequestMark['kind'], id: string): JournalRequestMark | null {
    const submission = kind === 'refused-send' ? journalDomainSubmission(this.scope, id) : undefined
    const itemId = kind === 'turn' ? this.canonical(id) : this.submissionItemId(id)
    if (!itemId) {
      return null
    }
    const row = this.row(itemId)
    const item: AgentJournalRenderItem | null = row ? JSON.parse(String(row.payload_json)) : null
    if (!item || !row?.root || item.sequence <= this.floor) {
      return null
    }
    const fence = Number(row.fence)
    if (kind === 'refused-send') {
      if (
        !submission ||
        isStructuredAgentSessionCommandEntry(item.body) ||
        submission.answeredInTurn?.via === 'steer'
      ) {
        return null
      }
      const failed =
        submission.dispatchState === 'rejected' &&
        classifyDispatchRejection(submission).verdict === 'failure'
      const linked = failed && submission.answeredInTurn?.turnItemId
      return {
        kind,
        id: item.itemId,
        fence,
        clientMessageId: id,
        mark: failed ? 'failure' : submission.dispatchState,
        ...(linked
          ? {
              linkedTurnItemId: this.canonical(linked),
              linked: this.request('turn', linked) ?? undefined
            }
          : {})
      }
    }
    const turn = readAgentJournalTurn(item.body)
    if (
      !turn ||
      isStructuredAgentSessionCommandTurn(turn, (key) => this.item(this.canonical(key))?.body)
    ) {
      return null
    }
    const opener = turn.userItemId && this.canonical(turn.userItemId)
    const input = opener ? journalDomainInputForItem(this.scope, opener) : undefined
    return {
      kind,
      id: item.itemId,
      fence,
      mark:
        agentTurnVerdict({ state: turn.state, outcome: readAgentJournalTurnOutcome(turn) }) ??
        turn.state,
      turnState: turn.state,
      personStopped: journalDomainStopDecidesTurn(
        journalDomainLatestStop(this.scope.db, this.scope, this.stopSettle),
        turn.turnId,
        turn.completedAt
      ),
      ...(input ? { clientMessageId: input.clientMessageId } : {})
    }
  }

  private submissionItemId(id: string): string | null {
    const row = this.scope.db
      .prepare(`SELECT item_id FROM journal_submission_attempts
      WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
      .get(...this.scope.prefix, id)
    return row ? String(row.item_id) : null
  }
}
