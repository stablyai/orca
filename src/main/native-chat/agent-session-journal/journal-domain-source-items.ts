import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalDomainSubmissionStoredFacts } from './journal-domain-submission-records'
import { journalDomainQueueRow } from './journal-domain-queue-rows'

/** Only the queue publication's reached identities may read an independent admission source. */
export function readJournalDomainSourceItems(
  scope: JournalSqlScope,
  clientMessageIds: readonly string[]
): AgentJournalRenderItem[] {
  if (clientMessageIds.length > 128) {
    throw new Error('journal source read exceeds its batch bound')
  }
  return clientMessageIds.flatMap((id) => {
    const itemId = agentJournalSubmissionKey(id)
    const visible = scope.db
      .prepare(`SELECT payload_json FROM journal_items
      WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
      .get(...scope.prefix, itemId)
    if (visible) {
      return [scope.decode<AgentJournalRenderItem>(visible.payload_json)]
    }
    const owner = scope.db
      .prepare(`SELECT attempt_sequence,attempt_index,facts_json
      FROM journal_submission_attempts WHERE session_id=? AND epoch=? AND message_id=?
      ORDER BY attempt_sequence DESC,attempt_index DESC LIMIT 1`)
      .get(...scope.prefix, id)
    const facts = owner && scope.decode<JournalDomainSubmissionStoredFacts>(owner.facts_json)
    const placement = facts?.admission.sourcePlacement
    if (placement && owner) {
      const row = scope.db
        .prepare(`SELECT admission_body_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND message_id=? AND attempt_sequence=? AND attempt_index=?`)
        .get(...scope.prefix, id, owner.attempt_sequence, owner.attempt_index)!
      if (row.admission_body_json === null) {
        throw new Error('retained journal source has no owned admission body')
      }
      const body = scope.decode<AgentJournalMessageItem>(row.admission_body_json)
      const handover = facts.handover
      return [
        handover
          ? {
              itemId,
              revision: 0,
              body,
              sequence: handover.sequence,
              observedAt: handover.at,
              turnScope: { kind: 'thread' as const },
              ...(handover.recovered ? { recovered: true as const, recoveredAt: handover.at } : {}),
              ...agentJournalLinkageFields(placement)
            }
          : { ...placement, body }
      ]
    }
    const card = journalDomainQueueRow(scope.db, scope, id)?.card
    return card
      ? [
          {
            itemId,
            revision: 0,
            body: card.body,
            sequence: card.queuedAt?.sequence ?? 0,
            observedAt: 0,
            turnScope: { kind: 'thread' as const }
          }
        ]
      : []
  })
}
