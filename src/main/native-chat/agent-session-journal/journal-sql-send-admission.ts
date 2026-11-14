import type Database from '../../sqlite/sync-database'
import { pendingPromptsAllUnanswerableHere } from '../../../shared/agent-session/agent-session-approval-subject'
import { refuse } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { journalDomainInputEligibility } from './journal-domain-input-eligibility'
import { JournalSqlScope } from './journal-sql-scope'
import { journalDomainSubmission } from './journal-domain-status-inputs'
import { journalDomainLinkedInputs } from './journal-domain-input-populations'
import { journalDomainQueueRow } from './journal-domain-queue-rows'
import { nextJournalDomainQueueCard } from './journal-domain-submission-consume'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import { readJournalSqlUsageLimitCut } from './journal-sql-status-cuts'
import { applyJournalDomainSubmission } from './journal-domain-submission-admission'
import { applyJournalDomainQueueCommand } from './journal-domain-queue-command'
import { finishJournalSqlCommand, journalSqlInputCoordinates } from './journal-sql-command-result'
import {
  queuedMessagePublishedBytesRefusal,
  publishedQueuedBodyBytes
} from './queued-messages/queued-message-published-bytes'
import type { JournalWriterCommand } from './journal-writer-command'
import type { JournalSendAdmissionResult } from './journal-send-admission'

/** Replay, queue eligibility, byte budget and acceptance share this writer position. */
export function applyJournalSqlSendAdmission(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'send-admission' }>
  },
  savedAt: number
) {
  const { operation, facts, target } = command
  if (!facts?.send) {
    throw new Error('send admission requires captured live authority')
  }
  const scope = new JournalSqlScope(db, target.sessionId, target.epoch)
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(...scope.prefix)!
  const empty = (value: JournalSendAdmissionResult) =>
    finishJournalSqlCommand(
      db,
      stateDirectory,
      { ...command, effects: undefined },
      {
        cursor: { epoch: target.epoch, sequence: Number(head.last_sequence) },
        inputChanged: false,
        items: [],
        cards: [],
        receipts: []
      },
      value,
      []
    )
  const { input } = operation
  const id = input.clientMessageId
  const draft = journalDomainQueueRow(db, scope, id)?.card
  const consumed =
    draft?.state === 'dispatched' && draft.consumedAs !== null
      ? journalDomainSubmission(scope, draft.consumedAs)
      : undefined
  let handoff
  if (!draft) {
    for (const send of journalDomainLinkedInputs(scope, id)) {
      if (
        send.queuedMessageId === id &&
        (send.submittedSequence ?? 0) >= (handoff?.submittedSequence ?? 0)
      ) {
        handoff = send
      }
    }
  }
  if (draft || handoff) {
    return empty({
      kind: 'admitted',
      value:
        consumed || (!draft && handoff?.dispatchState !== 'rejected')
          ? { clientMessageId: id, submission: { ...(consumed ?? handoff!) } }
          : {
              clientMessageId: id,
              queued: draft
                ? { messageId: id, position: draft.position, state: draft.state }
                : { messageId: id, position: 0, state: 'withdrawn' }
            }
    })
  }
  const existing = journalDomainSubmission(scope, id)
  if (existing) {
    return existing.payloadFingerprint !== input.payloadFingerprint
      ? empty({
          kind: 'refused',
          refusal: refuse(
            'agent_session_operation_invalid',
            { reason: 'messageIdReused' },
            `Message id ${id} was already used for another send.`
          )
        })
      : empty({ kind: 'admitted', value: { clientMessageId: id, submission: existing } })
  }
  const eligibility = journalDomainInputEligibility(scope, facts.send)
  if (eligibility.blocked) {
    return empty({
      kind: 'refused',
      refusal: refuse(
        'agent_session_operation_unknown',
        { reason: 'rewindUnconfirmed', rewindReason: 'outcome-unknown' },
        'agent_session_rewind:outcome-unknown'
      )
    })
  }
  let queue = false
  if (operation.fromAgent || !pendingPromptsAllUnanswerableHere(eligibility.prompts)) {
    queue = eligibility.prompts.length > 0 || eligibility.work.working() || !!eligibility.pending
    if (!queue && operation.fromAgent) {
      queue = readJournalDomainQueuePauseContext(
        db,
        scope,
        facts.reopenFloor ?? null,
        []
      ).pauses.some((pause) => pause.reason === 'failed')
    }
    if (!queue) {
      const next = nextJournalDomainQueueCard(db, scope, {
        reopenFloor: facts.reopenFloor ?? null,
        now: savedAt,
        automatic: false,
        steer: false,
        mail: facts.mail
      })
      if (next.kind === 'needs-custody') {
        return empty(next)
      }
      queue = next.card !== null
    }
  }
  if (
    operation.continuationOfTurnItemId !== undefined &&
    (queue ||
      readJournalSqlUsageLimitCut(eligibility.context)?.turnItemId !==
        operation.continuationOfTurnItemId)
  ) {
    return empty({
      kind: 'refused',
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'continuationSuperseded' },
        'This chat has moved on. Check the latest messages before continuing.'
      )
    })
  }
  if (queue) {
    const queuedBytes = Number(
      db
        .prepare(`SELECT COALESCE(SUM(length(CAST(json_extract(payload_json,'$.body') AS BLOB))),0) AS bytes
      FROM journal_queue_cards WHERE session_id=? AND epoch=? AND state IN ('waiting','returned')`)
        .get(...scope.prefix)!.bytes
    )
    const refusal = queuedMessagePublishedBytesRefusal(
      queuedBytes + publishedQueuedBodyBytes(input.body),
      operation.fromPerson
    )
    if (refusal) {
      return empty({ kind: 'refused', refusal })
    }
    const result = applyJournalDomainQueueCommand(
      db,
      stateDirectory,
      target,
      {
        kind: 'queue-insert',
        input: {
          messageId: id,
          body: input.body,
          options: input.options,
          deliveryMode: operation.deliveryMode,
          unattended: !operation.fromPerson,
          ...(input.origin === 'client' ? { requireAttachments: true as const } : {})
        }
      },
      savedAt
    )
    if (result.result.kind !== 'queue-insert') {
      throw new Error('send admission did not insert its queue card')
    }
    const card = result.result.card
    return finishJournalSqlCommand(
      db,
      stateDirectory,
      command,
      { ...result, items: [], receipts: [] },
      {
        kind: 'admitted',
        value: {
          clientMessageId: id,
          queued: { messageId: id, position: card.position, state: card.state }
        }
      } satisfies JournalSendAdmissionResult,
      [{ kind: 'queue', epoch: target.epoch, seq: result.cursor.sequence }]
    )
  }
  if (operation.queueOnly) {
    return empty({ kind: 'immediate' })
  }
  const result = applyJournalDomainSubmission(
    db,
    stateDirectory,
    target,
    { kind: 'submission', input },
    facts,
    savedAt
  )
  const submission = journalDomainSubmission(scope, id)
  if (!submission) {
    throw new Error('agent_session_submission_lost')
  }
  return finishJournalSqlCommand(
    db,
    stateDirectory,
    command,
    result,
    {
      kind: 'admitted',
      value: { clientMessageId: id, submission }
    } satisfies JournalSendAdmissionResult,
    journalSqlInputCoordinates(target.epoch, result.coordinates),
    result.items.map((item) => item.itemId)
  )
}
