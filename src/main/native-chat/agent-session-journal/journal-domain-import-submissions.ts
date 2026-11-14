import { journalInputOrder } from './input-order/journal-input-order'
import { memoryJournalMap } from './journal-memory-collections'
import { readAnsweredTurn } from './projection/journal-dispatch-reducer'
import type Database from '../../sqlite/sync-database'
import { journalOutcomeSource } from './outcomes/journal-outcome-format'
import { decodeJournalOutcome } from './outcomes/journal-outcome-codec'
import { outcomeFormat1EntryParsers } from './outcomes/journal-outcome-format-1'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  JOURNAL_DOMAIN_SUBMISSION_COLUMNS,
  journalDomainSubmissionColumns
} from './journal-domain-submission-columns'
import { journalRenderItem } from './projection/journal-render-item'
import { journalSubmissionFromRow } from './submissions/journal-submission-fold'
import type { JournalReducerState } from './projection/journal-reducer'
import {
  journalDomainSubmissionFactsJson,
  journalDomainSourcePlacement,
  type JournalDomainSubmissionAttempt
} from './journal-domain-submission-records'
import {
  journalInputSourceBody,
  journalInputSourceFamily,
  journalInputSourceScope,
  journalInputSourceSequence
} from './input-order/journal-input-source'

export type JournalDomainImportAttempt = JournalDomainSubmissionAttempt & {
  echoObserved: boolean
  current?: boolean
}

/** Interpret frozen source facts only during the one-way import. */
export function restoredJournalDomainSubmission(
  state: JournalReducerState,
  submission: AgentJournalSubmission,
  ordinal: number,
  admittedPersonal: boolean
): JournalDomainImportAttempt {
  const id = submission.clientMessageId
  const source = state.inputs.sources.get(id)
  const request = source?.kind === 'submission' ? source : source?.submission
  const handover = state.inputs.handovers.get(id)
  const place = state.queuedHandOffPlaces.get(id)
  const rejected = state.inputs.rejections.get(id)
  const rejectedEvent = rejected && 'kind' in rejected ? rejected : undefined
  const rejectedSend = rejected && !('kind' in rejected) ? rejected : undefined
  const original =
    source?.kind === 'outcome-admission'
      ? source.item
      : source &&
        journalRenderItem(
          agentJournalSubmissionKey(id),
          0,
          source.body,
          source,
          { kind: 'thread' },
          source
        )
  return {
    submission,
    sequence: journalInputSourceSequence(source) ?? submission.submittedSequence ?? 0,
    index: source?.kind === 'outcome-admission' ? (source.item.sequenceIndex ?? 0) : 0,
    // A retired outcome may outlive the reconstructed admission's ordinal.
    ordinal: Number.isFinite(ordinal) ? ordinal : (submission.submittedSequence ?? 0),
    candidate: state.inputs.candidates.has(id),
    admittedPersonal,
    echoObserved: state.inputs.echoes.has(agentJournalSubmissionKey(id)),
    ended: state.inputs.ended.has(id),
    admission: {
      body: journalInputSourceBody(source),
      ...(original ? { sourcePlacement: journalDomainSourcePlacement(original) } : {}),
      providerHandle: source?.kind === 'submission' ? source.providerHandle : null,
      fence: source?.fence ?? submission.fence,
      scope: journalInputSourceScope(source) ?? null,
      familyId: journalInputSourceFamily(source) ?? submission.queuedMessageId ?? null,
      origin: request?.origin ?? null,
      sourceKind: request?.source?.kind ?? null,
      options: request?.options ?? null
    },
    handover: handover
      ? {
          sequence: handover.seq,
          at: handover.ts,
          fence: handover.fence,
          scope: handover.turnScope ?? null,
          ...(handover.recovered ? { recovered: true as const } : {})
        }
      : null,
    handoverPlace: place
      ? {
          sequence: place.sequence,
          at: place.observedAt,
          scope: place.turnScope
        }
      : null,
    carries: state.stoppedHistoryCarried.get(id) ?? [],
    rejection: rejected
      ? {
          sequence: rejectedEvent?.seq ?? rejectedSend?.submittedSequence ?? 0,
          at: rejectedEvent?.ts ?? rejectedSend?.resolvedAt ?? rejectedSend?.submittedAt ?? 0,
          fence: rejected.fence,
          reason: rejected.reason,
          fact: rejected.rejection ?? null,
          recovered: rejected.recovered === true,
          keptMessageId: rejected.keptAsQueuedMessageId ?? null,
          ...(rejected.answeredInTurn === undefined
            ? {}
            : { answeredInTurn: readAnsweredTurn(rejected.answeredInTurn) })
        }
      : null,
    presentationMember: state.inputs.presentations.has(id),
    normalizedHandOff: state.normalizedHandOffs.has(id)
  }
}

/** One named current-attempt insert, idempotent while the chat is still unready. */
export function insertJournalDomainImportedSubmission(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  attempt: JournalDomainImportAttempt
): void {
  const { submission, admission, handover } = attempt
  db.prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,
    attempt_sequence,attempt_index,current,item_id,ordinal,candidate,admitted_personal,payload_json,echo_observed,
    admission_body_json,admission_family_id,handover_fence,facts_json,${JOURNAL_DOMAIN_SUBMISSION_COLUMNS.join(',')})
    VALUES(${Array.from({ length: 16 + JOURNAL_DOMAIN_SUBMISSION_COLUMNS.length }, () => '?').join(',')}) ON CONFLICT DO NOTHING`).run(
    target.sessionId,
    target.epoch,
    submission.clientMessageId,
    attempt.sequence,
    attempt.index,
    Number(attempt.current !== false),
    agentJournalSubmissionKey(submission.clientMessageId),
    attempt.ordinal,
    Number(attempt.candidate),
    Number(attempt.admittedPersonal),
    JSON.stringify(submission),
    Number(attempt.echoObserved),
    admission.body === null ? null : JSON.stringify(admission.body),
    admission.familyId,
    handover?.fence ?? null,
    journalDomainSubmissionFactsJson(attempt),
    ...journalDomainSubmissionColumns(submission, attempt.carries)
  )
}

/** Restore current dispatch membership from each saved submission. */
export function restoredJournalDomainSubmissions(
  state: JournalReducerState,
  personal: (submission: AgentJournalSubmission) => boolean,
  retiredAccepted: ReadonlyMap<string, AgentJournalSubmission> = new Map()
): JournalDomainImportAttempt[] {
  const order = journalInputOrder(state)
  const current = [...memoryJournalMap(state.submissions).values()].map((submission) =>
    restoredJournalDomainSubmission(
      state,
      submission,
      order.inputOrdinal(submission.clientMessageId),
      personal(submission)
    )
  )
  const retained = [
    ...new Set([...memoryJournalMap(state.inputs.sources).keys(), ...retiredAccepted.keys()])
  ].flatMap((id) => {
    if (state.submissions.has(id)) {
      return []
    }
    const source = state.inputs.sources.get(id)
    const submission =
      retiredAccepted.get(id) ??
      (source?.kind === 'submission' ? journalSubmissionFromRow(source) : source?.submission)
    if (!submission) {
      return []
    }
    return [
      {
        ...restoredJournalDomainSubmission(
          state,
          submission,
          order.inputOrdinal(id),
          retiredAccepted.has(id) && personal(submission)
        ),
        current: false
      }
    ]
  })
  return [...current, ...retained]
}

/** Preserve historical acceptance without restoring a deleted current submission key. */
export function readImportedRetiredAcceptances(
  db: Database.Database,
  state: JournalReducerState
): Map<string, AgentJournalSubmission> {
  const source = journalOutcomeSource(db, state.sessionId, state.epoch)
  const accepted = new Map<string, AgentJournalSubmission>()
  if (!source) {
    return accepted
  }
  const rows = db.prepare(`SELECT seq,field,entry_key,format,ordinal,value_json,deleted
    FROM journal_outcomes WHERE generation=? AND seq<=? AND field='submissions' AND deleted=0 ORDER BY seq DESC`)
  for (const row of rows.iterate(source.generation, source.through)) {
    const value = decodeJournalOutcome(row)
    const [id, submission] = outcomeFormat1EntryParsers.submissions.parse(JSON.parse(value.json))
    if (
      submission.dispatchState === 'accepted' &&
      !state.submissions.has(id) &&
      !accepted.has(id)
    ) {
      accepted.set(id, submission)
    }
  }
  return accepted
}
