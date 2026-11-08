import type Database from '../../sqlite/sync-database'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { journalMailSenderKey } from './journal-writer-host-facts'
import type { JournalWriterOperation } from './journal-writer-command'
import type {
  JournalDomainSubmissionFacts,
  JournalDomainSubmissionTarget
} from './journal-domain-submission-records'
import {
  journalDomainQueueRow,
  readJournalDomainQueueRow,
  type JournalDomainQueueRow
} from './journal-domain-queue-rows'
import { readJournalDomainQueuePauseContext } from './journal-domain-queue-pauses'
import { queuePauseHoldingInContext } from './queued-messages/queued-message-pause'
import { assertQueuedCardConsumable } from './queued-messages/journal-queue-mail-eligibility'
import { QueuedMessageNotOwedError } from './queued-messages/queued-message-consume-error'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'

type Submission = Extract<JournalWriterOperation, { kind: 'submission' }>

export type JournalDomainQueueSelection = {
  reopenFloor: AgentJournalCursor | null
  /** Wall-clock milliseconds that decide which persisted edit holds are live. */
  now: number
  steer: boolean
  /** Manual sends pass edit holds; automatic delivery waits behind them. */
  automatic: boolean
  /** Asked only for the first eligible mail card; past unavailable mail, later mail is skipped. */
  mailUnavailable: (card: QueuedMessageRow) => boolean
}

/** Current ordered cards and exact edit holds are selected on one snapshot, a bounded page at a time. */
export function nextJournalDomainQueueCard(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  selection: JournalDomainQueueSelection
): QueuedMessageRow | null {
  const { steer, automatic } = selection
  let after: { position: number; messageId: string } | undefined
  let pastUnavailableMail = false
  for (;;) {
    const rows = db
      .prepare(`SELECT card.message_id,card.revision,card.state,card.position,card.payload_json,
      EXISTS(SELECT 1 FROM journal_edit_leases AS lease
        WHERE lease.session_id=card.session_id AND lease.epoch=card.epoch
          AND lease.message_id=card.message_id AND lease.card_revision=card.revision
          AND lease.expires_at>?) AS edit_held
      FROM journal_queue_cards AS card WHERE card.session_id=? AND card.epoch=?
        AND card.state IN ('waiting','returned')
        ${after ? 'AND (card.position,card.message_id)>(?,?)' : ''}
      ORDER BY card.position,card.message_id LIMIT 64`)
      .all(
        selection.now,
        target.sessionId,
        target.epoch,
        ...(after ? [after.position, after.messageId] : [])
      )
    if (rows.length === 0) {
      return null
    }
    const context = readJournalDomainQueuePauseContext(
      db,
      target,
      selection.reopenFloor,
      rows.map((row) => String(row.message_id))
    )
    for (const row of rows) {
      if (automatic && row.edit_held) {
        return null
      }
      const { card } = readJournalDomainQueueRow(target.sessionId, row)
      after = { position: card.position, messageId: card.messageId }
      if (
        card.state !== 'waiting' ||
        card.holdReason !== null ||
        queuePauseHoldingInContext(context, card)
      ) {
        continue
      }
      const mail = orchestrationMailNotice(card.body.from)
      if (steer && (card.body.command || (!mail && card.deliveryMode !== 'steer'))) {
        continue
      }
      if (pastUnavailableMail && mail) {
        continue
      }
      if (mail && card.body.from && selection.mailUnavailable(card)) {
        pastUnavailableMail = true
        continue
      }
      return card
    }
    if (rows.length < 64) {
      return null
    }
  }
}

export function selectJournalDomainSubmissionCard(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: Submission,
  facts: JournalDomainSubmissionFacts,
  savedAt: number
): JournalDomainQueueRow | null {
  const { consume, input } = operation
  if (!consume) {
    return null
  }
  if ((input.queuedMessageId ?? consume.messageId) !== consume.messageId) {
    throw new Error(`submission ${input.clientMessageId} names a draft it does not consume`)
  }
  const current = journalDomainQueueRow(db, target, consume.messageId)
  assertQueuedCardConsumable(
    {
      ...consume,
      owed: undefined,
      consumedAs: input.clientMessageId,
      fingerprint: input.payloadFingerprint
    },
    current?.card ?? null,
    () =>
      nextJournalDomainQueueCard(db, target, {
        reopenFloor: facts.reopenFloor ?? null,
        now: savedAt,
        steer: consume.steer === true,
        automatic: true,
        mailUnavailable: (card) => {
          const key = journalMailSenderKey(card.body.from!)
          const authority = facts.mail?.find(([sender]) => sender === key)
          if (!authority) {
            throw new Error('journal automatic mail selection requires supplied sender authority')
          }
          return authority[1]
        }
      })
  )
  const owed = consume.owed ? (facts.owed ?? 'unavailable') : 'owed'
  if (owed !== 'owed') {
    throw new QueuedMessageNotOwedError(consume.messageId, owed)
  }
  return current
}
