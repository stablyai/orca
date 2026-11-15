import type {
  AgentJournalMessageItem,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentJournalLinkageFields } from '../../../shared/agent-session/journal/agent-session-journal-producer'
import type { JournalSqlScope } from './journal-sql-scope'
import type { JournalDomainSubmissionStoredFacts } from './journal-domain-submission-records'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import type { JournalDomainHistoryHeader } from './journal-domain-history-window'

export type JournalDomainSourceHeader = JournalDomainHistoryHeader & {
  source: {
    id: string
    placement: Omit<AgentJournalRenderItem, 'body'>
    attemptSequence: number | null
    attemptIndex: number | null
  }
}

export function isJournalDomainSourceHeader(
  header: JournalDomainHistoryHeader
): header is JournalDomainSourceHeader {
  return 'source' in header
}

/** The supplied population is the current image queue, never retained submission history. */
export function readJournalDomainSourceHeaders(
  scope: JournalSqlScope,
  ids: readonly string[],
  window: { before?: number; from?: number; limit?: number; own?: boolean } = {}
): JournalDomainSourceHeader[] {
  if (ids.length === 0) {
    return []
  }
  const wanted = ids.map((id) => ({ id, itemId: agentJournalSubmissionKey(id) }))
  return scope.db
    .prepare(`SELECT json_extract(wanted.value,'$.id') AS id,
      json_extract(wanted.value,'$.itemId') AS item_id, wanted.key AS source_order,
      CASE WHEN json_extract(owner.facts_json,'$.admission.sourcePlacement') IS NOT NULL
        THEN COALESCE(json_extract(owner.facts_json,'$.handover.sequence'),
          json_extract(owner.facts_json,'$.admission.sourcePlacement.sequence'))
        ELSE COALESCE((CASE WHEN json_valid(card.payload_json) THEN json_extract(card.payload_json,'$.queuedAt.sequence') END),0) END AS source_sequence,
      CASE WHEN json_extract(owner.facts_json,'$.handover') IS NOT NULL THEN 0
        ELSE COALESCE(json_extract(owner.facts_json,'$.admission.sourcePlacement.sequenceIndex'),0)
        END AS source_index,
      owner.attempt_sequence,owner.attempt_index,owner.facts_json,
      octet_length(owner.admission_body_json) AS body_bytes,
      CASE WHEN json_extract(owner.facts_json,'$.admission.sourcePlacement') IS NULL
        THEN (CASE WHEN json_valid(card.payload_json) THEN json_extract(card.payload_json,'$.queuedAt.sequence') END) END AS queued_sequence,
      CASE WHEN json_extract(owner.facts_json,'$.admission.sourcePlacement') IS NULL
        THEN (CASE WHEN json_valid(card.payload_json) THEN octet_length(json_extract(card.payload_json,'$.body')) END) END AS card_body_bytes,
      COALESCE(octet_length(current.payload_json),0) AS submission_bytes
      FROM json_each(?3) wanted
      LEFT JOIN journal_submission_attempts owner ON owner.rowid=(
        SELECT rowid FROM journal_submission_attempts
        WHERE session_id=?1 AND epoch=?2 AND message_id=json_extract(wanted.value,'$.id')
        ORDER BY attempt_sequence DESC,attempt_index DESC LIMIT 1)
      LEFT JOIN journal_submission_attempts current ON current.session_id=?1 AND current.epoch=?2
        AND current.message_id=json_extract(wanted.value,'$.id') AND current.current=1
      LEFT JOIN journal_queue_cards card INDEXED BY journal_queue_source_metadata
        ON card.session_id=?1 AND card.epoch=?2
        AND card.message_id=json_extract(wanted.value,'$.id')
      WHERE COALESCE(current.dispatch_state,'')<>'accepted' AND NOT EXISTS(
        SELECT 1 FROM journal_items WHERE session_id=?1 AND epoch=?2
        AND item_id=json_extract(wanted.value,'$.itemId') AND hidden=0)
      AND (json_extract(owner.facts_json,'$.admission.sourcePlacement') IS NOT NULL
        OR card.message_id IS NOT NULL)
      AND source_sequence<?4 AND source_sequence>=?5
      AND (?7=0 OR json_extract(owner.facts_json,'$.admission.sourcePlacement.agentId') IS NULL)
      ORDER BY source_sequence DESC,source_index DESC,CAST(wanted.key AS INTEGER) DESC LIMIT ?6`)
    .all(
      ...scope.prefix,
      JSON.stringify(wanted),
      window.before ?? Number.MAX_SAFE_INTEGER,
      window.from ?? -Number.MAX_SAFE_INTEGER,
      window.limit ?? ids.length,
      Number(window.own === true)
    )
    .map((row) => {
      const facts = row.facts_json
        ? scope.decode<JournalDomainSubmissionStoredFacts>(row.facts_json)
        : undefined
      const original = facts?.admission?.sourcePlacement
      const placement = original
        ? sourcePlacement(String(row.item_id), original, facts?.handover)
        : {
            itemId: String(row.item_id),
            revision: 0,
            sequence: Number(row.queued_sequence ?? 0),
            observedAt: 0,
            turnScope: { kind: 'thread' as const }
          }
      return {
        itemId: placement.itemId,
        sequence: placement.sequence,
        sequenceIndex: placement.sequenceIndex ?? 0,
        ordinal: Number.MAX_SAFE_INTEGER - ids.length + Number(row.source_order),
        own: placement.agentId === undefined,
        subagentGroupKey: null,
        bytes:
          Buffer.byteLength(JSON.stringify(placement)) +
          8 +
          Number(original ? row.body_bytes : row.card_body_bytes) +
          Number(row.submission_bytes),
        source: {
          id: String(row.id),
          placement,
          attemptSequence: original ? Number(row.attempt_sequence) : null,
          attemptIndex: original ? Number(row.attempt_index) : null
        }
      }
    })
}

function sourcePlacement(
  itemId: string,
  original: Omit<AgentJournalRenderItem, 'body'>,
  handover: JournalDomainSubmissionStoredFacts['handover'] | undefined
): Omit<AgentJournalRenderItem, 'body'> {
  return handover
    ? {
        itemId,
        revision: 0,
        sequence: handover.sequence,
        observedAt: handover.at,
        turnScope: { kind: 'thread' },
        ...(handover.recovered ? { recovered: true, recoveredAt: handover.at } : {}),
        ...agentJournalLinkageFields(original)
      }
    : original
}

/** Read only a positional/event candidate, including an ambiguous exact byte-boundary group. */
export function readJournalDomainSourceBody(
  scope: JournalSqlScope,
  { source }: JournalDomainSourceHeader
): AgentJournalRenderItem {
  const row =
    source.attemptSequence === null
      ? scope.db
          .prepare(`SELECT json_extract(payload_json,'$.body') AS body
          FROM journal_queue_cards WHERE session_id=? AND epoch=? AND message_id=?`)
          .get(...scope.prefix, source.id)
      : scope.db
          .prepare(`SELECT admission_body_json AS body FROM journal_submission_attempts
          WHERE session_id=? AND epoch=? AND message_id=? AND attempt_sequence=? AND attempt_index=?`)
          .get(...scope.prefix, source.id, source.attemptSequence, source.attemptIndex)
  if (!row?.body) {
    throw new Error('retained journal source has no owned body')
  }
  return { ...source.placement, body: scope.decode<AgentJournalMessageItem>(row.body) }
}

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
    const placement = facts?.admission?.sourcePlacement
    if (placement && owner) {
      const row = scope.db
        .prepare(`SELECT admission_body_json FROM journal_submission_attempts
        WHERE session_id=? AND epoch=? AND message_id=? AND attempt_sequence=? AND attempt_index=?`)
        .get(...scope.prefix, id, owner.attempt_sequence, owner.attempt_index)!
      if (row.admission_body_json === null) {
        throw new Error('retained journal source has no owned admission body')
      }
      const body = scope.decode<AgentJournalMessageItem>(row.admission_body_json)
      return [{ ...sourcePlacement(itemId, placement, facts.handover), body }]
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
