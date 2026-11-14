import type Database from '../../sqlite/sync-database'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { agentSessionJournalProviderHandle } from '../../../shared/agent-session/lifecycle/provider-handles/agent-session-provider-handle-encoding'
import { readAgentSessionExecutionOptions } from '../../../shared/agent-session/options/protocol/agent-session-execution-options'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { claimAgentSessionAttachmentsInTransaction } from '../agent-session-attachments/agent-session-attachment-claims'
import type { JournalWriterOperation } from './journal-writer-command'
import { AgentSessionJournalError, assertJournalFence } from './writing/journal-write-guards'
import { writeJournalDomainCurrentItem } from './journal-domain-current-item'
import { selectJournalDomainSubmissionCard } from './journal-domain-submission-consume'
import type {
  JournalDomainSubmissionCommit,
  JournalDomainSubmissionFacts,
  JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import {
  journalDomainAdmittedPersonal,
  journalDomainQueueRow,
  replaceJournalDomainQueueRow
} from './journal-domain-queue-rows'
import {
  journalDomainEditLeaseDeadline,
  retireJournalDomainEditHolds
} from './journal-domain-edit-leases'
import { readJournalDomainTurnScope } from './journal-domain-turn-scope'
import { writeJournalDomainQueueReopenMark } from './journal-domain-queue-pauses'
import { appendJournalSqlEvent } from './journal-sql-event-tail'
import { advanceJournalDomainSubmissionRevision } from './journal-domain-submission-revision'
import {
  JOURNAL_DOMAIN_SUBMISSION_COLUMNS,
  journalDomainSubmissionColumns
} from './journal-domain-submission-columns'

/** Accepted input, queue ownership and attachment claims precede provider dispatch atomically. */
export function applyJournalDomainSubmission(
  db: Database.Database,
  stateDirectory: string,
  target: JournalDomainSubmissionTarget,
  operation: Extract<JournalWriterOperation, { kind: 'submission' }>,
  facts: JournalDomainSubmissionFacts,
  savedAt: number
): JournalDomainSubmissionCommit<AgentJournalCursor> {
  if (!db.isTransaction) {
    throw new Error('journal submission requires its writer transaction')
  }
  if (facts.identity.sessionId !== target.sessionId) {
    throw new Error('journal submission identity does not match its target')
  }
  const prefix = [target.sessionId, target.epoch] as const
  const head = db
    .prepare(`SELECT last_sequence,highest_fence FROM journal_chat_state
    WHERE session_id=? AND epoch=?`)
    .get(...prefix)
  if (!head) {
    throw new Error('journal submission targets a retired chat epoch')
  }
  const { input } = operation
  assertJournalFence(input.fence, Number(head.highest_fence))
  if (
    db
      .prepare(`SELECT 1 FROM journal_submission_attempts
    WHERE session_id=? AND epoch=? AND message_id=? AND current=1`)
      .get(...prefix, input.clientMessageId)
  ) {
    throw new AgentSessionJournalError(
      'journal_submission_exists',
      `a submission ${input.clientMessageId} is already recorded`
    )
  }
  const selected = operation.consume
    ? selectJournalDomainSubmissionCard(db, target, operation, facts, savedAt)
    : input.queuedMessageId === undefined
      ? null
      : journalDomainQueueRow(db, target, input.queuedMessageId)
  const claims = claimAgentSessionAttachmentsInTransaction(db, {
    stateDirectory,
    sessionId: target.sessionId,
    body: input.body,
    required: input.origin === 'client' && !operation.consume,
    now: savedAt
  })
  const initial = { epoch: target.epoch, sequence: Number(head.last_sequence) }
  const result: JournalDomainSubmissionCommit<AgentJournalCursor> = {
    cursor: initial,
    value: initial,
    coordinates: [],
    items: [],
    removedItemIds: [],
    receipts: [],
    cards: [],
    inputChanged: true,
    ...(claims.referenced.size ? { referencedUploads: [...claims.referenced] } : {})
  }
  const floor = facts.reopenFloor
  if (floor?.epoch === target.epoch) {
    const sequence = initial.sequence + 1
    writeJournalDomainQueueReopenMark(db, target, sequence, floor.sequence)
    appendJournalSqlEvent(
      db,
      target,
      sequence,
      savedAt,
      { items: [], submissions: [], cards: [] },
      { fence: input.fence, observedAt: savedAt }
    )
    result.coordinates.push({
      kind: 'queue-reopen',
      cursor: { epoch: target.epoch, sequence },
      fence: input.fence,
      observedAt: savedAt
    })
  }
  const sequence = initial.sequence + result.coordinates.length + 1
  const cursor = { epoch: target.epoch, sequence }
  const familyId = operation.consume?.messageId ?? input.queuedMessageId
  const options = readAgentSessionExecutionOptions(input.options)
  const submission: AgentJournalSubmission = {
    clientMessageId: input.clientMessageId,
    fence: input.fence,
    payloadFingerprint: input.payloadFingerprint,
    dispatchState: 'pending',
    providerItemId: null,
    reason: null,
    submittedAt: savedAt,
    resolvedAt: null,
    submittedSequence: sequence,
    ...(input.handoverRecorded ? { handoverRecorded: true, acceptedSequence: sequence } : {}),
    ...(familyId !== undefined ? { queuedMessageId: familyId } : {}),
    ...(input.origin !== undefined ? { origin: input.origin } : {}),
    ...(input.source !== undefined ? { source: { kind: input.source.kind } } : {}),
    ...(options ? { options } : {})
  }
  const itemId = agentJournalSubmissionKey(input.clientMessageId)
  const scope = input.handoverRecorded
    ? { kind: 'thread' as const }
    : readJournalDomainTurnScope(db, target, input.body)
  const item: AgentJournalRenderItem = {
    itemId,
    revision: 0,
    sequence,
    observedAt: savedAt,
    body: input.body,
    turnScope: scope
  }
  const ordinal = Number(
    db
      .prepare(`SELECT COALESCE(MAX(ordinal),-1)+1 AS ordinal
    FROM journal_submission_attempts WHERE session_id=? AND epoch=?`)
      .get(...prefix)!.ordinal
  )
  if (familyId !== undefined) {
    db.prepare(`UPDATE journal_submission_attempts SET candidate=0
      WHERE session_id=? AND epoch=? AND admission_family_id=? AND current=1 AND candidate<>0`).run(
      ...prefix,
      familyId
    )
  }
  const payload = JSON.stringify(submission)
  advanceJournalDomainSubmissionRevision(db, target, input.clientMessageId, payload)
  db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,attempt_index,current,
    item_id,ordinal,candidate,admitted_personal,payload_json,
    admission_body_json,admission_family_id,facts_json,${JOURNAL_DOMAIN_SUBMISSION_COLUMNS.join(',')})
    VALUES(${Array.from({ length: 14 + JOURNAL_DOMAIN_SUBMISSION_COLUMNS.length }, () => '?').join(',')})`).run(
    ...prefix,
    input.clientMessageId,
    sequence,
    0,
    1,
    itemId,
    ordinal,
    1,
    Number(
      familyId !== undefined
        ? selected !== null && journalDomainAdmittedPersonal(selected.card)
        : input.source?.kind === 'user' || (input.source === undefined && input.origin === 'client')
    ),
    payload,
    JSON.stringify(input.body),
    familyId ?? null,
    JSON.stringify({
      admission: {
        sourcePlacement: {
          itemId,
          revision: 0,
          sequence,
          observedAt: savedAt,
          turnScope: { kind: 'thread' }
        },
        providerHandle: agentSessionJournalProviderHandle(facts.identity),
        fence: input.fence,
        scope: null,
        origin: input.origin ?? null,
        sourceKind: input.source?.kind ?? null,
        options: input.options ?? null
      },
      handover: null,
      handoverPlace: null,
      carries: [],
      rejection: null,
      presentationMember: false,
      normalizedHandOff: false,
      ended: false
    }),
    ...journalDomainSubmissionColumns(submission, [])
  )
  const blocked = db
    .prepare(`SELECT 1 FROM journal_items WHERE session_id=? AND epoch=? AND item_id=?
    UNION ALL SELECT 1 FROM journal_item_tombstones WHERE session_id=? AND epoch=? AND item_id=? AND revision>=0 LIMIT 1`)
    .get(...prefix, itemId, ...prefix, itemId)
  if (!blocked) {
    result.insertedItemIds = [itemId]
    result.items = writeJournalDomainCurrentItem(db, target, {
      item,
      hidden: false,
      ownerFence: input.fence
    })
  }
  if (selected) {
    const card = {
      ...selected.card,
      state: 'dispatched' as const,
      consumedAs: input.clientMessageId,
      holdReason: null,
      returnedReason: null,
      returnedRejection: null
    }
    replaceJournalDomainQueueRow(db, target, selected, card)
    result.cards.push(card)
    if (retireJournalDomainEditHolds(db, target, [card.messageId])) {
      result.editDeadline = journalDomainEditLeaseDeadline(db, target, savedAt)
    }
  }
  appendJournalSqlEvent(
    db,
    target,
    sequence,
    savedAt,
    {
      items: result.items.map((written) => ({
        itemId: written.itemId,
        revision: written.revision,
        sequence: written.sequence,
        sequenceIndex: written.sequenceIndex ?? 0
      })),
      submissions: [input.clientMessageId],
      cards: result.cards.map((card) => card.messageId)
    },
    { fence: input.fence, observedAt: savedAt }
  )
  result.cursor = cursor
  result.value = cursor
  result.coordinates.push({
    kind: 'submission',
    cursor,
    fence: input.fence,
    observedAt: savedAt,
    clientMessageId: input.clientMessageId
  })
  return result
}
