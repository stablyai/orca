// A session owner's say over its mail (group rooms): what one pass carries, and cards it no longer wants.

import type { MessageRow } from './db/orchestration-records'
import type { OrchestrationDb } from './db/orchestration-db'
import { selectOrchestrationPointerBatch } from './mailbox/terminal-pointer/mailbox-pointer-eligibility'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import * as mailCustody from './mailbox/structured-mail/structured-mail-custody'
import type {
  StructuredMailMessageVerifier,
  StructuredMailboxPointerHost,
  StructuredPointerSendOutcome
} from './mailbox/structured-pointer/structured-mailbox-pointer-host-contract'
import type { StructuredPointerTarget } from './mailbox/structured-pointer/structured-mailbox-pointer-delivery'
import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-messages/queued-message-consume-error'

type Owner = Pick<StructuredMailboxPointerHost, 'narrowBatch' | 'mailHeld'>
type Selection = Omit<Parameters<typeof selectOrchestrationPointerBatch>[0], 'waiters'> & {
  sessionId: string
  offerable: (message: MessageRow) => boolean
}

/** The next mail a pass may offer `sessionId`, narrowed by its owner. Mail the owner ended is
 *  stamped delivered, and selection looks past it, so the pass sees only mail it can carry. */
export function selectOwnedMail(
  deps: {
    host: Owner
    getMessageWaiters: (
      handle: string
    ) => Parameters<typeof selectOrchestrationPointerBatch>[0]['waiters']
  },
  { sessionId, offerable, ...selection }: Selection
): MessageRow[] {
  if (deps.host.mailHeld?.(sessionId)) {
    return []
  }
  const waiters = deps.getMessageWaiters(selection.mailboxHandle)
  for (;;) {
    const selected = selectOrchestrationPointerBatch({ ...selection, waiters }).messages.filter(
      offerable
    )
    const narrowed = deps.host.narrowBatch?.(sessionId, selected) ?? {
      messages: selected,
      ended: []
    }
    if (narrowed.ended.length > 0) {
      selection.db.markAsDelivered(narrowed.ended, selection.mailboxHandle)
    }
    // Retired mail is progress: look past it; anything else waits for its own edge.
    if (narrowed.ended.length === 0 || narrowed.messages.length > 0) {
      return narrowed.messages
    }
  }
}

/** A waiting card the owner would no longer carry (a stopped group request's mail) is stale, so the
 *  queue withdraws it by the same test a pass retires uncarded mail with, not failing it at handover.
 *  One the owner holds stays in place, unavailable, until its owner takes mail again. */
export function ownerAdjustedOwed(
  owed: QueuedMessageOwed,
  { narrowBatch: narrow, mailHeld }: Owner,
  sessionId: string,
  messageIds: readonly string[],
  db: OrchestrationDb | null
): QueuedMessageOwed {
  if (owed !== 'owed' || messageIds.length === 0) {
    return owed
  }
  if (mailHeld?.(sessionId)) {
    return 'unavailable'
  }
  if (!narrow || !db) {
    return owed
  }
  const rows = messageIds.flatMap((messageId) => db.getMessageById(messageId) ?? [])
  return rows.length > 0 && narrow(sessionId, rows).ended.length === rows.length ? 'stale' : owed
}

/** Verify targeted mail before whole-mail chat admission; returns a synchronous commit-time recheck or null when held. */
export async function verifyStructuredMailAdmission(
  verify: StructuredMailMessageVerifier | undefined,
  db: OrchestrationDb,
  mailboxHandle: string,
  target: StructuredPointerTarget,
  message: MessageRow
): Promise<(() => boolean) | null> {
  if (!verify) {
    return () => true
  }
  const checked = await verify(db, mailboxHandle, target, message)
  return checked.ok ? checked.reverifySync : null
}

/** Settle a structured send outcome and schedule redelivery when custody moved or released. */
export async function settleStructuredSendOutcome(args: {
  db: OrchestrationDb
  host: StructuredMailboxPointerHost
  attempt: StructuredMailSendRow
  outcome: StructuredPointerSendOutcome
  lastOwed: QueuedMessageOwed
  owedNow: () => QueuedMessageOwed
  redeliver: () => void
}): Promise<'next' | 'park'> {
  const { db, host, attempt, outcome, lastOwed, owedNow, redeliver } = args
  switch (outcome.kind) {
    case 'unattached':
    case 'refused':
      db.releaseStructuredMailSend(attempt)
      return 'park'
    case 'obsolete':
      db.releaseStructuredMailSend(attempt)
      if (lastOwed === 'stale') {
        queueMicrotask(redeliver)
      }
      return lastOwed === 'unavailable' ? 'park' : 'next'
    case 'queued':
      return 'next'
    case 'sent':
      if (outcome.state === 'accepted' || outcome.state === 'unknown') {
        const observed = await mailCustody.observeStructuredMailAttempt(host, attempt)
        const settled = mailCustody.settleStructuredMailAttempt(db, attempt, observed, owedNow)
        if (settled.released) {
          queueMicrotask(redeliver)
        }
      }
      return 'next'
  }
}
