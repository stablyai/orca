/** Whether a chat still owes an orchestration message it was sent, and what became of each send. */

import type { OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'
import type { StructuredPointerTarget } from './structured-mailbox-pointer-delivery'
import { structuredMailboxCustody } from './structured-session-mail-target'
import { structuredMailFitsWhole } from './structured-mail-source'
import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import {
  orchestrationMailNotice,
  type AgentMessageSource
} from '../../../shared/agent-session/agent-session-message-source'
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

/** The one authority every handover asks: whether this session may still be handed this mail now.
 *  Only a readable fact decides it is no longer owed; a fact that cannot be read holds it. */
export function structuredMailOwed(input: {
  db: OrchestrationDb
  sessionId: string
  mailboxHandle: string
  messageIds: readonly string[]
  resolve: (mailboxHandle: string) => StructuredPointerTarget | null
  /** Why no chat resolves: someone else holds it, or that cannot be read now. */
  unresolved: (mailboxHandle: string) => 'elsewhere' | 'unverifiable'
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
    // A terminal, a released worker or another host holds it; a restart still restoring it holds it here.
    return input.unresolved(mailboxHandle) === 'elsewhere' ? 'stale' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

/** Whether a session may be handed mail now, from the mailbox's durable facts. Read only. */
export class StructuredMailAuthority {
  constructor(
    private readonly deps: {
      getDb: () => OrchestrationDb | null
      resolve: (mailboxHandle: string) => StructuredPointerTarget | null
      /** Why no chat resolves a mailbox; read from the database unless a test supplies it. */
      unresolvedCustody?: (mailboxHandle: string) => 'elsewhere' | 'unverifiable'
      /** Whether nothing can own the mailbox again; read from the database unless a test supplies it. */
      mailboxEnded?: (mailboxHandle: string) => boolean
    }
  ) {}

  owedTo(
    sessionId: string,
    mailboxHandle: string,
    messageIds: readonly string[]
  ): QueuedMessageOwed {
    const db = this.deps.getDb()
    return db
      ? structuredMailOwed({
          db,
          sessionId,
          mailboxHandle,
          messageIds,
          resolve: this.deps.resolve,
          unresolved: (handle) => this.unresolved(handle),
          ended: (handle) => this.ended(handle)
        })
      : 'unavailable'
  }

  owedNow(
    sessionId: string,
    from: AgentMessageSource,
    db: OrchestrationDb | null
  ): QueuedMessageOwed {
    const mail = orchestrationMailNotice(from)
    if (!mail) {
      return 'owed'
    }
    // No orchestration database: nothing can owe this mail any more.
    const ids = mail.messages.map((message) => message.messageId)
    return db ? this.owedTo(sessionId, mail.mailbox, ids) : 'stale'
  }

  ended(mailboxHandle: string): boolean {
    return (
      this.deps.mailboxEnded?.(mailboxHandle) ??
      structuredMailboxEnded(mailboxHandle, this.deps.getDb())
    )
  }

  /** A resolver that found no chat where the database names one cannot decide. */
  private unresolved(mailboxHandle: string): 'elsewhere' | 'unverifiable' {
    if (this.deps.unresolvedCustody) {
      return this.deps.unresolvedCustody(mailboxHandle)
    }
    const custody = structuredMailboxCustody(mailboxHandle, this.deps.getDb())
    return custody === 'elsewhere' ? 'elsewhere' : 'unverifiable'
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

/** Settle what became of earlier sends: the ids still in a chat's hands, and sends to make again.
 *  The chat's host answers what each became; this only stamps it, each retirement guarded by its
 *  attempt, so an old answer never ends a newer send. */
export async function settleStructuredMailSends(input: {
  db: OrchestrationDb
  mailboxHandle: string
  host: Pick<StructuredMailboxPointerHost, 'observe' | 'withdraw' | 'wakeQueue'>
  cliCommand: OrchestrationCliCommand
  owed: (sessionId: string, messageIds: readonly string[]) => QueuedMessageOwed
}): Promise<{ outstanding: Set<string>; resend: StructuredMailResend[]; released: boolean }> {
  const { db, mailboxHandle, host } = input
  const outstanding = new Set<string>()
  const resend: StructuredMailResend[] = []
  let released = false
  for (const row of db.getStructuredMailSends(mailboxHandle)) {
    const owed = input.owed(row.session_id, [row.message_id])
    const state = await host.observe(row.session_id, row.operation_id)
    const message = db.getMessageById(row.message_id)
    const unread = message !== undefined && !message.read ? message : undefined
    const retire = (consumed: boolean) => db.retireStructuredMailSend(row, consumed)
    // No longer this chat's: mail still unread goes to whoever owns the mailbox now, never read.
    const release = () => {
      released = db.releaseStructuredMailSend(row) || released
    }
    switch (state.kind) {
      case 'accepted':
        // A pointer's handover shows the agent none of an oversized message; `check` still has it.
        retire(unread !== undefined && structuredMailFitsWhole(unread, input.cliCommand))
        continue
      case 'unknown':
        // It may have reached the agent: never sent again; `check` still returns it.
        retire(false)
        continue
      case 'refused':
        release()
        continue
      case 'rejected':
        if (state.cancelled) {
          retire(false)
        } else if (owed === 'stale') {
          release()
        } else {
          if (state.recovered && owed === 'owed') {
            resend.push({ row, renew: true })
          }
          outstanding.add(row.message_id)
        }
        continue
      case 'withdrawn':
        if (owed === 'owed') {
          // The person deleted the card, as with any queued message, pointer or whole.
          retire(true)
        } else if (owed === 'stale') {
          release()
        } else {
          outstanding.add(row.message_id)
        }
        continue
      case 'absent':
        if (owed === 'stale') {
          release()
          continue
        }
        if (owed === 'owed') {
          // Reserved, then never admitted (a crash between them): the same id is admitted fresh.
          const mintedAt = parseAgentSessionOperationTimestamp(row.operation_id) ?? 0
          resend.push({ row, renew: Date.now() - mintedAt > REUSABLE_OPERATION_AGE_MS })
        }
        outstanding.add(row.message_id)
        continue
      case 'waiting':
      case 'unreadable':
        if (owed === 'stale' && state.kind === 'waiting') {
          if (await host.withdraw(row.session_id, row.operation_id)) {
            release()
            continue
          }
        } else if (unread && !unread.delivered_at) {
          // A record saved before reservations: the chat holds it, so selection must skip it.
          db.markAsDelivered([row.message_id], mailboxHandle)
        }
        if (owed === 'owed' && state.kind === 'waiting') {
          // Its owner may only now be readable: a card the queue passed over goes without a later action.
          host.wakeQueue(row.session_id)
        }
        outstanding.add(row.message_id)
        continue
    }
  }
  return { outstanding, resend, released }
}
