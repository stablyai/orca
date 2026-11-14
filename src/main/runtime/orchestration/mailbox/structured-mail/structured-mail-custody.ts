/** Whether a chat still owes an orchestration message it was sent, and what became of each send. */

import type { OrchestrationDb } from '../../db/orchestration-db'
import type { OrchestrationCliCommand } from '../../workers/launch/orchestration-cli-command'
import type { StructuredMailSendRow } from '../../db/messages/structured-mail-send-store'
import type { StructuredMailboxPointerHost } from '../structured-pointer/structured-mailbox-pointer-host-contract'
import type { StructuredPointerTarget } from '../structured-pointer/structured-mailbox-pointer-delivery'
import { structuredMailboxCustody } from '../routing/structured-session-mail-target'
import { structuredMailWasDeliveredWhole } from './structured-mail-whole'
import type { JournalMailObservation } from '../../../../native-chat/agent-session-journal/journal-mail-observation'
import { reconcileLifecycleMessage } from '../../workers/lifecycle/lifecycle-reconciliation'
import type { QueuedMessageOwed } from '../../../../native-chat/agent-session-journal/queued-messages/queued-message-consume-error'
import {
  orchestrationMailNotice,
  type AgentMessageSource
} from '../../../../../shared/agent-session/agent-session-message-source'
import {
  AGENT_SESSION_MAX_NEW_OPERATION_AGE_MS,
  AGENT_SESSION_OPERATION_FUTURE_SKEW_MS,
  parseAgentSessionOperationTimestamp
} from '../../../../../shared/agent-session/agent-session-host-authority'

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
  claimedDeliveryId?: string
}): QueuedMessageOwed {
  const { db, mailboxHandle } = input
  try {
    const delivery = db.getOutstandingMailboxDelivery?.(mailboxHandle)
    const held = delivery?.id === input.claimedDeliveryId ? undefined : delivery?.messageIds
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
    messageIds: readonly string[],
    claimedDeliveryId?: string
  ): QueuedMessageOwed {
    const db = this.deps.getDb()
    return db
      ? structuredMailOwed({
          db,
          sessionId,
          mailboxHandle,
          messageIds,
          claimedDeliveryId,
          resolve: this.deps.resolve,
          unresolved: (handle) => this.unresolved(handle),
          ended: (handle) => this.ended(handle)
        })
      : 'unavailable'
  }

  owedNow(
    sessionId: string,
    from: AgentMessageSource,
    db: OrchestrationDb | null,
    claimedDeliveryId?: string
  ): QueuedMessageOwed {
    const mail = orchestrationMailNotice(from)
    if (!mail) {
      return 'owed'
    }
    // No orchestration database: nothing can owe this mail any more.
    const ids = mail.messages.map((message) => message.messageId)
    return db ? this.owedTo(sessionId, mail.mailbox, ids, claimedDeliveryId) : 'stale'
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
    return db?.hasStructuredMailSend(mailboxHandle) ?? false
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
  host: Pick<StructuredMailboxPointerHost, 'observe' | 'observeMail' | 'withdraw' | 'wakeQueue'>
  cliCommand: OrchestrationCliCommand
  owed: (sessionId: string, messageIds: readonly string[]) => QueuedMessageOwed
}): Promise<{ outstanding: Set<string>; resend: StructuredMailResend[]; released: boolean }> {
  const { db, mailboxHandle, host } = input
  const outstanding = new Set<string>()
  const resend: StructuredMailResend[] = []
  // Once per chat after the pass, however many of its cards the queue may now hand over.
  const wake = new Set<string>()
  let released = false
  for (const row of db.getStructuredMailSends(mailboxHandle)) {
    let observation = await observeStructuredMailAttempt(host, row)
    if (
      input.owed(row.session_id, [row.message_id]) === 'stale' &&
      observation.state.kind === 'waiting'
    ) {
      await host.withdraw(row.session_id, row.operation_id)
      observation = await observeStructuredMailAttempt(host, row)
    }
    const decision = settleStructuredMailAttempt(db, row, observation, () =>
      input.owed(row.session_id, [row.message_id])
    )
    if (decision.outstanding) {
      outstanding.add(row.message_id)
    }
    if (decision.resend) {
      resend.push({ row, renew: decision.renew })
    }
    if (decision.wake) {
      wake.add(row.session_id)
    }
    released ||= decision.released
  }
  wake.forEach((sessionId) => host.wakeQueue(sessionId))
  return { outstanding, resend, released }
}

export async function observeStructuredMailAttempt(
  host: Pick<StructuredMailboxPointerHost, 'observe' | 'observeMail'>,
  row: StructuredMailSendRow
): Promise<JournalMailObservation> {
  return host.observeMail
    ? host.observeMail(row)
    : {
        epoch: '',
        state: await host.observe(row.session_id, row.operation_id),
        body: null,
        withdrawal: 'unknown'
      }
}

/** Every consumer applies the observed outcome to the current exact attempt and current custody. */
export function settleStructuredMailAttempt(
  db: OrchestrationDb,
  row: StructuredMailSendRow,
  observation: JournalMailObservation,
  currentOwed: () => QueuedMessageOwed
) {
  const decision = { outstanding: false, released: false, resend: false, renew: false, wake: false }
  const current = db.getStructuredMailSend(row.mailbox_handle, row.message_id)
  if (
    !current ||
    current.operation_id !== row.operation_id ||
    current.session_id !== row.session_id
  ) {
    return decision
  }
  const owed = currentOwed()
  const state = observation.state
  const retire = (consumed: boolean) => db.retireStructuredMailSend(row, consumed)
  const release = () => {
    decision.released = db.releaseStructuredMailSend(row)
  }
  switch (state.kind) {
    case 'accepted': {
      const message = db.getMessageById(row.message_id)
      if (message) {
        reconcileLifecycleMessage(db, message)
      }
      const corrected = db.getMessageById(row.message_id)
      retire(
        !!corrected &&
          !corrected.read &&
          structuredMailWasDeliveredWhole(row, corrected, observation)
      )
      break
    }
    case 'unknown':
      retire(false)
      break
    case 'refused':
      release()
      break
    case 'rejected':
      if (state.cancelled) {
        retire(false)
      } else if (owed === 'stale') {
        release()
      } else {
        decision.outstanding = true
        decision.resend = state.recovered && owed === 'owed'
        decision.renew = true
      }
      break
    case 'withdrawn':
      if (
        observation.withdrawal === 'system' ||
        (observation.withdrawal === 'person' && owed === 'stale')
      ) {
        release()
      } else if (observation.withdrawal === 'person' && owed === 'owed') {
        retire(true)
      } else {
        decision.outstanding = true
      }
      break
    case 'absent':
      if (owed === 'stale') {
        release()
      } else {
        decision.outstanding = true
        decision.resend = owed === 'owed'
        decision.renew =
          Date.now() - (parseAgentSessionOperationTimestamp(row.operation_id) ?? 0) >
          REUSABLE_OPERATION_AGE_MS
      }
      break
    case 'waiting':
    case 'unreadable': {
      const unread = db.getMessageById(row.message_id)
      if (unread && !unread.read && !unread.delivered_at) {
        db.markAsDelivered([row.message_id], row.mailbox_handle)
      }
      decision.outstanding = true
      decision.wake = owed === 'owed' && state.kind === 'waiting'
      break
    }
  }
  return decision
}
