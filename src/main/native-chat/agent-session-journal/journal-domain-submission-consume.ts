import type { SqliteRow } from '../../sqlite/sqlite-statement'
import type Database from '../../sqlite/sync-database'
import { journalMailSenderKey, type JournalMailCustody } from './journal-writer-host-facts'
import type { AgentMessageSource } from '../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageOwed } from './queued-messages/queued-message-consume-error'
import { orchestrationMailNotice } from '../../../shared/agent-session/agent-session-message-source'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
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
  mail?: JournalMailCustody
}

export type JournalDomainQueuePick =
  | { kind: 'selected'; card: QueuedMessageRow | null; owed?: QueuedMessageOwed }
  | { kind: 'needs-custody'; source: AgentMessageSource }

/** Current ordered cards and exact edit holds are selected on one snapshot, a bounded page at a time. */
export function nextJournalDomainQueueCard(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  selection: JournalDomainQueueSelection,
  pauseHead?: SqliteRow
): JournalDomainQueuePick {
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
      ${
        pauseHead
          ? `,EXISTS(SELECT 1 FROM journal_queue_clear_members member
        WHERE member.session_id=card.session_id AND member.epoch=card.epoch
          AND member.message_id=card.message_id) AS clear_member`
          : ''
      }
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
      return { kind: 'selected', card: null }
    }
    const context = readJournalDomainQueuePauseContext(
      db,
      target,
      selection.reopenFloor,
      rows.map((row) => String(row.message_id)),
      pauseHead
        ? {
            head: pauseHead,
            clearMembers: new Set(
              rows.filter((row) => row.clear_member).map((row) => String(row.message_id))
            )
          }
        : undefined
    )
    for (const row of rows) {
      if (automatic && row.edit_held) {
        return { kind: 'selected', card: null }
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
      let owed: QueuedMessageOwed | undefined
      if (mail && card.body.from) {
        owed = selection.mail?.find(
          ([sender]) => sender === journalMailSenderKey(card.body.from!)
        )?.[1]
        if (owed === undefined) {
          return { kind: 'needs-custody', source: card.body.from }
        }
        if (owed === 'unavailable') {
          pastUnavailableMail = true
          continue
        }
      }
      return { kind: 'selected', card, owed }
    }
    if (rows.length < 64) {
      return { kind: 'selected', card: null }
    }
  }
}

export function selectJournalDomainSubmissionCard(
  db: Database.Database,
  target: JournalDomainSubmissionTarget,
  operation: Submission,
  facts: JournalDomainSubmissionFacts,
  _savedAt: number
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
    current?.card ?? null
  )
  const owed = consume.owed ? (facts.owed ?? 'unavailable') : 'owed'
  if (owed !== 'owed') {
    throw new QueuedMessageNotOwedError(consume.messageId, owed)
  }
  return current
}
