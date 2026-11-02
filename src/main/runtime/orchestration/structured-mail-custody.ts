/** Whether a chat still owes an orchestration message it was sent, and what became of each send. */

import type { OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import { structuredMailFitsWhole } from './structured-mail-source'
import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../shared/agent-session/agent-session-host-authority'

/** A recorded send made again: under the same id when it was never admitted, or under a new one
 *  after a proven rejection and a later turn or /clear. */
export type StructuredMailResend = { row: StructuredMailSendRow; renew: boolean }

/** The host admits a new id only this young; past it a resend of a never-admitted send renews it. */
const REUSABLE_OPERATION_AGE_MS =
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS - AGENT_SESSION_OPERATION_FUTURE_SKEW_MS

/** A mailbox nothing can own again: its Dispatch settled or is gone, or its Run is gone. */
export function structuredMailboxEnded(
  mailboxHandle: string,
  db: OrchestrationDb | null | undefined
): boolean {
  if (mailboxHandle.startsWith('dispatch:')) {
    const status = db?.getDispatchContextById?.(mailboxHandle.slice('dispatch:'.length))?.status
    return status !== 'pending' && status !== 'dispatched'
  }
  return mailboxHandle.startsWith('run:') && !db?.getRun?.(mailboxHandle.slice('run:'.length))
}

/** The one authority every handover asks: whether this session may still be handed this mail now. */
export function structuredMailOwed(input: {
  db: OrchestrationDb
  sessionId: string
  mailboxHandle: string
  messageIds: readonly string[]
  resolve: (mailboxHandle: string) => StructuredPointerTarget | null
  ended: (mailboxHandle: string) => boolean
}): QueuedMessageOwed {
  const { db, mailboxHandle } = input
  try {
    const held = db.getOutstandingMailboxDelivery?.(mailboxHandle)?.messageIds
    const here = input.messageIds.some(
      (id) => !held?.includes(id) && db.areUnreadMessages(mailboxHandle, [id])
    )
    if (!here || input.ended(mailboxHandle)) {
      return 'stale'
    }
    const target = input.resolve(mailboxHandle)
    if (target) {
      return target.sessionId === input.sessionId ? 'owed' : 'stale'
    }
    // No owner resolves, but nothing durable ended it: a restart may still be restoring it.
    return 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export function hasStructuredMailSends(db: OrchestrationDb | null, mailboxHandle: string): boolean {
  try {
    return (db?.getStructuredMailSends(mailboxHandle).length ?? 0) > 0
  } catch {
    // A database closing under shutdown has nothing left to settle.
    return false
  }
}

/** A send no longer owed where it went: forget it, and let mail still in this mailbox be selected
 *  again for whoever owns the mailbox now. */
export function retireStaleMailSend(db: OrchestrationDb, row: StructuredMailSendRow): void {
  db.deleteStructuredMailSend(row.mailbox_handle, row.message_id)
  if (db.areUnreadMessages(row.mailbox_handle, [row.message_id])) {
    db.markAsUndelivered([row.message_id])
  }
}

/** Settle what became of earlier sends: the ids still in a chat's hands, and sends to make again. */
export async function settleStructuredMailSends(input: {
  db: OrchestrationDb
  mailboxHandle: string
  host: Pick<StructuredMailboxPointerHost, 'observe' | 'withdraw'>
  cliCommand: OrchestrationCliCommand
  owed: (sessionId: string, messageIds: readonly string[]) => QueuedMessageOwed
}): Promise<{ outstanding: Set<string>; resend: StructuredMailResend[] }> {
  const { db, mailboxHandle, host } = input
  const outstanding = new Set<string>()
  const resend: StructuredMailResend[] = []
  for (const row of db.getStructuredMailSends(mailboxHandle)) {
    const owed = input.owed(row.session_id, [row.message_id])
    const state = await host.observe(row.session_id, row.operation_id)
    const message = db.getMessageById(row.message_id)
    const unread = message !== undefined && !message.read
    // A pointer's handover shows the agent none of an oversized message; `check` still has it.
    const readsWhole = () =>
      message !== undefined && !message.read && structuredMailFitsWhole(message, input.cliCommand)
    const retire = () => db.deleteStructuredMailSend(mailboxHandle, row.message_id)
    switch (state.kind) {
      case 'accepted':
        if (readsWhole()) {
          db.markAsReadAndDelivered([row.message_id])
        }
        retire()
        continue
      case 'unknown':
        // It may have reached the agent: never sent again; `check` still returns it.
        retire()
        continue
      case 'rejected':
        if (state.cancelled) {
          retire()
        } else if (owed === 'stale') {
          retireStaleMailSend(db, row)
        } else {
          if (state.recovered && owed === 'owed') {
            resend.push({ row, renew: true })
          }
          outstanding.add(row.message_id)
        }
        continue
      case 'withdrawn':
        if (owed === 'owed') {
          // The person deleted the card, as with any queued message.
          if (readsWhole()) {
            db.markAsReadAndDelivered([row.message_id])
          }
          retire()
        } else if (owed === 'stale') {
          retireStaleMailSend(db, row)
        } else {
          outstanding.add(row.message_id)
        }
        continue
      case 'absent':
        if (owed === 'stale') {
          retireStaleMailSend(db, row)
          continue
        }
        if (owed === 'owed') {
          // Recorded, then never admitted (a crash between them): the same id is admitted fresh.
          const mintedAt = parseAgentSessionOperationTimestamp(row.operation_id) ?? 0
          resend.push({ row, renew: Date.now() - mintedAt > REUSABLE_OPERATION_AGE_MS })
        }
        outstanding.add(row.message_id)
        continue
      case 'waiting':
      case 'unreadable':
        if (owed === 'stale' && state.kind === 'waiting') {
          if (await host.withdraw(row.session_id, row.operation_id)) {
            retireStaleMailSend(db, row)
            continue
          }
        } else if (unread && !message.delivered_at) {
          // The send landed but its stamp did not: the chat holds it, so selection must skip it.
          db.markAsDelivered([row.message_id], mailboxHandle)
        }
        outstanding.add(row.message_id)
        continue
    }
  }
  return { outstanding, resend }
}
