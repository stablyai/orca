import type Database from '../../sqlite/sync-database'
import type {
  AgentJournalCursor,
  AgentSessionJournalIdentity,
  AgentSessionJournalProviderHandle
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalAcceptanceReceipt,
  AgentJournalAnsweredTurn,
  AgentJournalMessageItem,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../shared/agent-session/journal/agent-session-journal-turn-scope'
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/agent-session-execution-options'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'

export type JournalDomainSubmissionTarget = { sessionId: string; epoch: string }

export type JournalDomainSubmissionFacts = {
  identity: AgentSessionJournalIdentity
  reopenFloor?: AgentJournalCursor | null
  owed?: QueuedMessageOwed
  /** Finite external sender availability, sampled before admission to the writer. */
  mail?: readonly (readonly [string, boolean])[]
}

export type JournalDomainSubmissionAdmission = {
  body: AgentJournalMessageItem | null
  providerHandle: AgentSessionJournalProviderHandle | null
  fence: number
  scope: AgentJournalTurnScope | null
  familyId: string | null
  origin: 'client' | 'host' | null
  sourceKind: string | null
  options: AgentSessionExecutionOptions | null
}

export type JournalDomainSubmissionHandover = {
  sequence: number
  at: number
  fence: number
  scope: AgentJournalTurnScope | null
}

/** Retained independently: a later itemless handover cannot replace its presentation. */
export type JournalDomainSubmissionHandoverPlace = {
  sequence: number
  at: number
  scope: AgentJournalTurnScope | undefined
}

export type JournalDomainSubmissionRejection = {
  sequence: number
  at: number
  fence: number
  reason: string | null
  fact: UnreadAgentSessionFailureFact | null
  recovered: boolean
  keptMessageId: string | null
  answeredInTurn?: AgentJournalAnsweredTurn | null
}

/** Named domain inputs, not an encoded replay row or restored reducer source. */
export type JournalDomainSubmissionAttempt = {
  sequence: number
  index: number
  ordinal: number
  candidate: boolean
  admittedPersonal: boolean
  submission: AgentJournalSubmission
  admission: JournalDomainSubmissionAdmission
  handover: JournalDomainSubmissionHandover | null
  handoverPlace: JournalDomainSubmissionHandoverPlace | null
  carries: readonly string[]
  rejection: JournalDomainSubmissionRejection | null
  presentationMember: boolean
  normalizedHandOff: boolean
}

export type JournalDomainSubmissionCoordinate = {
  kind: 'submission' | 'dispatch' | 'queue-reopen'
  cursor: AgentJournalCursor
  fence: number
  observedAt: number
  clientMessageId?: string
}

export type JournalDomainSubmissionCommit<Value = AgentJournalCursor | null | undefined> = {
  cursor: AgentJournalCursor
  value: Value
  /** Empty means the legacy no-op would not invoke its row-bound receipt. */
  coordinates: JournalDomainSubmissionCoordinate[]
  items: AgentJournalRenderItem[]
  removedItemIds: string[]
  receipts: AgentJournalAcceptanceReceipt[]
  cards: QueuedMessageRow[]
  inputChanged: boolean
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
  referencedUploads?: string[]
}

export function readJournalDomainSubmissionAttempt(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  messageId: string,
  includeAdmissionBody = true
): JournalDomainSubmissionAttempt | null {
  const row = db
    .prepare(`SELECT attempt_sequence,attempt_index,ordinal,candidate,admitted_personal,payload_json,
    CASE WHEN ? THEN admission_body_json END AS admission_body_json,
    admission_provider_handle_json,admission_fence,admission_scope_json,admission_family_id,
    admission_origin,admission_source_kind,admission_options_json,handover_sequence,handover_at,handover_fence,
    handover_scope_json,handover_place_sequence,handover_place_at,handover_place_scope_json,carries_json,rejection_sequence,rejection_at,rejection_fence,
    rejection_reason,rejection_fact_json,rejection_recovered,rejection_kept_message_id,rejection_answered_turn_json,
    presentation_member,normalized_handoff FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(Number(includeAdmissionBody), target.sessionId, target.epoch, messageId)
  if (!row) {
    return null
  }
  return {
    sequence: Number(row.attempt_sequence),
    index: Number(row.attempt_index),
    ordinal: Number(row.ordinal),
    candidate: Boolean(row.candidate),
    admittedPersonal: Boolean(row.admitted_personal),
    submission: JSON.parse(String(row.payload_json)),
    admission: {
      body: row.admission_body_json === null ? null : JSON.parse(String(row.admission_body_json)),
      providerHandle:
        row.admission_provider_handle_json === null
          ? null
          : JSON.parse(String(row.admission_provider_handle_json)),
      fence: Number(row.admission_fence),
      scope:
        row.admission_scope_json === null ? null : JSON.parse(String(row.admission_scope_json)),
      familyId: row.admission_family_id === null ? null : String(row.admission_family_id),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the typed admission writer or importer supplies this domain column.
      origin: row.admission_origin as JournalDomainSubmissionAdmission['origin'],
      sourceKind: row.admission_source_kind === null ? null : String(row.admission_source_kind),
      options:
        row.admission_options_json === null ? null : JSON.parse(String(row.admission_options_json))
    },
    handover:
      row.handover_sequence === null
        ? null
        : {
            sequence: Number(row.handover_sequence),
            at: Number(row.handover_at),
            fence: Number(row.handover_fence),
            scope:
              row.handover_scope_json === null ? null : JSON.parse(String(row.handover_scope_json))
          },
    handoverPlace:
      row.handover_place_sequence === null
        ? null
        : {
            sequence: Number(row.handover_place_sequence),
            at: Number(row.handover_place_at),
            scope:
              row.handover_place_scope_json === null
                ? undefined
                : JSON.parse(String(row.handover_place_scope_json))
          },
    carries: row.carries_json === null ? [] : JSON.parse(String(row.carries_json)),
    rejection:
      row.rejection_sequence === null
        ? null
        : {
            sequence: Number(row.rejection_sequence),
            at: Number(row.rejection_at),
            fence: Number(row.rejection_fence),
            reason: row.rejection_reason === null ? null : String(row.rejection_reason),
            fact:
              row.rejection_fact_json === null ? null : JSON.parse(String(row.rejection_fact_json)),
            recovered: Boolean(row.rejection_recovered),
            keptMessageId:
              row.rejection_kept_message_id === null ? null : String(row.rejection_kept_message_id),
            ...(row.rejection_answered_turn_json === null
              ? {}
              : { answeredInTurn: JSON.parse(String(row.rejection_answered_turn_json)) })
          },
    presentationMember: Boolean(row.presentation_member),
    normalizedHandOff: Boolean(row.normalized_handoff)
  }
}

/** Source bodies are released at settlement; the immutable optimistic message then owns its body. */
export function readJournalDomainSubmissionBody(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  messageId: string
): AgentJournalMessageItem | null {
  const row = db
    .prepare(`SELECT attempt.admission_body_json, item.payload_json
    FROM journal_submission_attempts AS attempt LEFT JOIN journal_items AS item
      ON item.session_id=attempt.session_id AND item.epoch=attempt.epoch AND item.item_id=attempt.item_id
    WHERE attempt.session_id=? AND attempt.epoch=? AND attempt.message_id=? AND attempt.current=1`)
    .get(target.sessionId, target.epoch, messageId)
  if (row?.admission_body_json !== null && row?.admission_body_json !== undefined) {
    return JSON.parse(String(row.admission_body_json))
  }
  const item: AgentJournalRenderItem | null = row?.payload_json
    ? JSON.parse(String(row.payload_json))
    : null
  return item?.body.kind === 'message' ? item.body : null
}
