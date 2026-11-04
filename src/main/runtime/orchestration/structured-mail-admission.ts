import type { MessageRow, OrchestrationDb } from './db'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import type {
  StructuredPointerTarget,
  StructuredPointerDeliveryDependencies
} from './structured-mailbox-delivery-contract'
import type { MailDiscoveryWalk } from './structured-mail-discovery'
import type { StructuredMailboxParking } from './structured-mailbox-parking'
import type { StructuredMailAuthority, StructuredMailResend } from './structured-mail-custody'
import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import { structuredMailAttempt } from './structured-mail-custody'
import {
  structuredMailMessage,
  structuredMailWrittenAt,
  structuredMailAfterStop
} from './structured-mail-source'
import {
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  settleStructuredMailAdmit,
  type StructuredMailAdmitStep
} from './structured-mailbox-admit-step'

/** Early eligibility never consumes mail; the reservation and final host check still decide custody. */
export class StructuredMailAdmission<TWaiter extends OrchestrationMessageWaiter> {
  private readonly releaseHints = new Map<
    string,
    { db: OrchestrationDb; row: StructuredMailSendRow }
  >()
  constructor(
    private readonly deps: StructuredPointerDeliveryDependencies<TWaiter> & {
      authority: StructuredMailAuthority
      parking: StructuredMailboxParking
      discover: (mailbox: string) => void
      redeliver: (mailbox: string) => void
    }
  ) {}

  reset(): void {
    this.releaseHints.clear()
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  async admit(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    message: MessageRow,
    pass: MailDiscoveryWalk,
    again?: StructuredMailResend
  ): Promise<StructuredMailAdmitStep> {
    const latest = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!latest || this.deps.getDb() !== db) {
      return 'park'
    }
    target = latest
    const sessionId = target.sessionId
    const eligibility = this.deps.host.readEligibility(sessionId)
    if (!eligibility) {
      return 'park'
    }
    pass.reconcile(db, target, eligibility, this.deps.getMessageWaiters(mailboxHandle))
    this.deps.parking.park(mailboxHandle, sessionId, pass.reservedTypes)
    if (
      !structuredMailAfterStop(
        structuredMailWrittenAt(db, mailboxHandle, message),
        eligibility.stopAt
      )
    ) {
      pass.held = true
      return 'held'
    }
    const fence = eligibility.fence
    const { body, whole } = structuredMailMessage({
      db,
      mailboxHandle,
      dispatchId: target.dispatchId,
      message,
      cliCommand: this.deps.getCliCommand(),
      senderSnapshot: this.deps.senderSnapshot
    })
    const attempt = structuredMailAttempt(mailboxHandle, message.id, sessionId, again)
    // Reserved before the send, with its delivered stamp, so a crash after it lands finds the card
    // instead of sending twice. Only the pass whose reservation lands sends.
    if (!db.reserveStructuredMailSend(attempt, again?.row.operation_id)) {
      return 'next'
    }
    // The host's last answer, set inside its own check: a holder, so the read after the send sees it.
    const last: { owed: QueuedMessageOwed } = { owed: 'owed' }
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: attempt.operation_id,
      expectedRuntimeFence: fence,
      body,
      createdAt: structuredMailWrittenAt(db, mailboxHandle, message),
      stillOwed: () => {
        last.owed = this.deps.authority.owedTo(sessionId, mailboxHandle, [message.id])
        return (
          last.owed === 'owed' &&
          !shouldReleaseOrchestrationPointer(
            this.deps.getDb(),
            mailboxHandle,
            [message],
            this.deps.getMessageWaiters(mailboxHandle)
          )
        )
      }
    })
    const step = settleStructuredMailAdmit({
      db,
      attempt,
      outcome,
      owed: last.owed,
      whole,
      held: pass
    })
    if (db.getMessageById(message.id)?.to_handle !== mailboxHandle) {
      this.released(db, attempt)
    }
    return step
  }

  released(db: OrchestrationDb, row: StructuredMailSendRow): void {
    this.releaseHints.set(row.operation_id, { db, row })
    queueMicrotask(() => {
      try {
        this.flushReleaseHints()
      } catch {
        this.deps.scheduleRedelivery?.(row.mailbox_handle)
      }
    })
  }

  flushReleaseHints(): void {
    const wake = new Set<string>()
    for (const [key, { db, row }] of this.releaseHints) {
      if (db !== this.deps.getDb()) {
        this.releaseHints.delete(key)
        continue
      }
      if (db.db?.isTransaction) {
        this.deps.scheduleRedelivery?.(row.mailbox_handle)
        continue
      }
      this.releaseHints.delete(key)
      const message = db.getMessageById(row.message_id)
      if (
        !message ||
        message.read ||
        message.delivered_at !== null ||
        db.getStructuredMailSend(row.mailbox_handle, row.message_id)?.operation_id ===
          row.operation_id
      ) {
        continue
      }
      // A release's old attempt can name a different mailbox from the row's committed address.
      if (message.to_handle !== row.mailbox_handle) {
        wake.add(message.to_handle)
      }
    }
    for (const mailbox of wake) {
      this.deps.discover(mailbox)
      this.deps.redeliver(mailbox)
    }
  }
}
