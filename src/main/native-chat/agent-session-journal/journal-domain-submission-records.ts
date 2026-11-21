import type { JournalPromptDispatch } from './journal-writer-changes'
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
import type { AgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { UnreadAgentSessionFailureFact } from '../../../shared/agent-session/failures/agent-session-failure'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import type { JournalSqlAcceptedInputs } from './journal-sql-accepted-inputs'
import type { JournalMailCustody } from './journal-writer-host-facts'

export type JournalDomainSubmissionTarget = { sessionId: string; epoch: string }

export type JournalDomainSubmissionFacts = {
  identity: AgentSessionJournalIdentity
  reopenFloor?: AgentJournalCursor | null
  owed?: QueuedMessageOwed
  mail?: JournalMailCustody
}

export type JournalDomainSubmissionAdmission = {
  body: AgentJournalMessageItem | null
  sourcePlacement?: Omit<AgentJournalRenderItem, 'body'>
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
  recovered?: true
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
  ended?: boolean
}

export type JournalDomainSubmissionCoordinate = {
  kind: 'submission' | 'dispatch' | 'queue-reopen'
  cursor: AgentJournalCursor
  fence: number
  observedAt: number
  clientMessageId?: string
}

export type JournalDomainSubmissionCommit<Value = AgentJournalCursor | null | undefined> = {
  promptDispatches?: JournalPromptDispatch[]
  cursor: AgentJournalCursor
  value: Value
  /** Empty means the legacy no-op would not invoke its row-bound receipt. */
  coordinates: JournalDomainSubmissionCoordinate[]
  items: AgentJournalRenderItem[]
  insertedItemIds?: string[]
  removedItemIds: string[]
  receipts: AgentJournalAcceptanceReceipt[]
  cards: QueuedMessageRow[]
  inputChanged: boolean
  acceptedInputs?: JournalSqlAcceptedInputs
  editDeadline?: number | null
  referencedUploads?: string[]
}

export type JournalDomainSubmissionStoredFacts = Pick<
  JournalDomainSubmissionAttempt,
  | 'handover'
  | 'handoverPlace'
  | 'carries'
  | 'rejection'
  | 'presentationMember'
  | 'normalizedHandOff'
  | 'ended'
> & {
  admission: Omit<JournalDomainSubmissionAdmission, 'body' | 'familyId'>
}

export function journalDomainSourcePlacement(item: AgentJournalRenderItem) {
  const { body: _body, ...placement } = item
  return placement
}

export function journalDomainSubmissionFactsJson(attempt: JournalDomainSubmissionAttempt): string {
  const { body: _body, familyId: _family, ...admission } = attempt.admission
  const {
    handover,
    handoverPlace,
    carries,
    rejection,
    presentationMember,
    normalizedHandOff,
    ended
  } = attempt
  const facts: JournalDomainSubmissionStoredFacts = {
    admission,
    handover,
    handoverPlace,
    carries,
    rejection,
    presentationMember,
    normalizedHandOff,
    ended: ended === true
  }
  return JSON.stringify(facts)
}

export function readJournalDomainSubmissionAttempt(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  messageId: string,
  includeAdmissionBody = true
): JournalDomainSubmissionAttempt | null {
  const row = db
    .prepare(`SELECT attempt_sequence,attempt_index,ordinal,candidate,admitted_personal,payload_json,
    CASE WHEN ? THEN admission_body_json END AS admission_body_json,admission_family_id,facts_json
    FROM journal_submission_attempts WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
    .get(Number(includeAdmissionBody), target.sessionId, target.epoch, messageId)
  if (!row) {
    return null
  }
  const facts: JournalDomainSubmissionStoredFacts = JSON.parse(String(row.facts_json))
  return {
    sequence: Number(row.attempt_sequence),
    index: Number(row.attempt_index),
    ordinal: Number(row.ordinal),
    candidate: Boolean(row.candidate),
    admittedPersonal: Boolean(row.admitted_personal),
    submission: JSON.parse(String(row.payload_json)),
    ...facts,
    admission: {
      ...facts.admission,
      body: row.admission_body_json === null ? null : JSON.parse(String(row.admission_body_json)),
      familyId: row.admission_family_id === null ? null : String(row.admission_family_id)
    }
  }
}

/** A retained source survives independent revisions and removal of its optimistic item. */
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
