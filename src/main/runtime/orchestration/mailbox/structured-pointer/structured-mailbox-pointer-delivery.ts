/** Chats queue whole mail one per turn behind work/questions; terminals keep the PTY pointer lane. */

import type { MessageRow } from '../../db/orchestration-records'
import type { OrchestrationDb } from '../../db/orchestration-db'
import type { SenderSnapshotResolver } from '../senders/agent-message-sender'
import {
  selectOrchestrationPointerBatch,
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from '../terminal-pointer/mailbox-pointer-eligibility'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import type { StructuredPointerDeliveryDependencies } from './structured-mailbox-pointer-host-contract'
import { structuredMailMessage } from '../structured-mail/structured-mail-source'
import type { StructuredMailSendRow } from '../../db/messages/structured-mail-send-store'
import type { QueuedMessageOwed } from '../../../../native-chat/agent-session-journal/queued-messages/queued-message-consume-error'
import type { AgentMessageSource } from '../../../../../shared/agent-session/agent-session-message-source'
import { StructuredMailboxParking } from '../structured-mail/structured-mailbox-parking'
import { StructuredMailSettledState } from '../structured-mail/structured-mail-settled-state'
import * as mailCustody from '../structured-mail/structured-mail-custody'

export type StructuredPointerTarget = {
  sessionId: string
  /** Direct peer mail has no Dispatch; that absence must not prevent worker nudges. */
  dispatchId: string | null
}

type AdmitStep = 'next' | 'park'

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  /** Edges that arrived during a pass: one more pass runs after it, so none is lost. */
  private readonly rerun = new Map<string, Set<string>>()
  private readonly parking = new StructuredMailboxParking({
    watchJournal: (sessionId, onActivity) => this.deps.host.watchJournal(sessionId, onActivity),
    onActivity: (sessionId) => this.onJournalActivity(sessionId)
  })

  private readonly authority: mailCustody.StructuredMailAuthority
  private readonly settledState = new StructuredMailSettledState()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {
    this.authority = new mailCustody.StructuredMailAuthority({
      ...deps,
      resolve: deps.resolveStructuredTarget
    })
  }

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    // Earlier sends are settled even when no chat owns the mailbox now; only an owner is sent to.
    if (!target && !mailCustody.hasStructuredMailSends(this.deps.getDb(), mailboxHandle)) {
      // A still-running pass forgets itself after observing cleanup.
      if (!this.inFlight.has(mailboxHandle)) {
        this.settledState.forget(mailboxHandle)
      }
      return false
    }
    void this.deliver(mailboxHandle, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
    })
    return target !== null
  }

  /** Retry mail parked on this session's settlement or reattach journal edge. */
  onJournalActivity(sessionId: string): void {
    // The watch stays through its own redrive: only a move, or the last obligation ending, ends it.
    for (const [mailboxHandle, parked] of this.parking.parkedFor(sessionId)) {
      this.settledState.invalidate(mailboxHandle)
      void this.deliver(mailboxHandle, parked.reservedTypes).catch(() => undefined)
    }
  }

  /** Whether a status callback is news to this session's mail; see StructuredMailSettledState. */
  statusChanged(sessionId: string, status: string | null): boolean {
    const fence = this.deps.host.currentFence(sessionId)
    return this.settledState.statusChanged(sessionId, status, fence)
  }

  /** Prune only this recorded session; settlement removes resolver identity and transient nulls also affect siblings. */
  forgetSession(sessionId: string): void {
    this.parking.forget(sessionId)
    this.settledState.forgetSession(sessionId)
    // Settlement can end the Dispatch a card still waits for: this session's mailboxes, by its index.
    try {
      this.withdrawStale(
        this.deps.getDb()?.getStructuredMailSendMailboxesForSession(sessionId) ?? []
      )
    } catch {
      // A database closing under shutdown has no cards left to settle.
    }
  }

  /** Mail a check took, a move re-addressed, or an owner gave up may still wait as a card: delete
   *  those cards so no agent is handed it. Visible cleanup only; the queue asks at handover anyway.
   *  Only the mailboxes the action touched; every one only at startup and reset. */
  withdrawStale(mailboxes?: Iterable<string>): void {
    let scope: Iterable<string>
    try {
      scope = mailboxes ?? this.deps.getDb()?.getStructuredMailSendMailboxes() ?? []
    } catch {
      // A database closing under shutdown has no cards left to settle.
      return
    }
    for (const mailboxHandle of scope) {
      this.settledState.invalidate(mailboxHandle)
      this.deliverForHandle(mailboxHandle)
    }
  }

  /** Read only: the queue asks this choosing and publishing its next card, so it settles nothing. */
  owedNow(
    sessionId: string,
    from: AgentMessageSource,
    db: OrchestrationDb | null,
    claimedDeliveryId?: string
  ): QueuedMessageOwed {
    return this.authority.owedNow(sessionId, from, db, claimedDeliveryId)
  }

  private async deliver(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): Promise<void> {
    if (this.inFlight.has(mailboxHandle)) {
      const reserved = this.rerun.get(mailboxHandle) ?? new Set<string>()
      reservedTypes?.forEach((type) => reserved.add(type))
      this.rerun.set(mailboxHandle, reserved)
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      await this.pass(mailboxHandle, reservedTypes)
    } catch (error) {
      // A send or settle that threw leaves its reservation without a definite answer: the next pass
      // asks about it, under its own id, before choosing newer mail.
      this.settledState.forget(mailboxHandle)
      throw error
    } finally {
      this.inFlight.delete(mailboxHandle)
      const rerun = this.rerun.get(mailboxHandle)
      if (rerun) {
        this.rerun.delete(mailboxHandle)
        void this.deliver(mailboxHandle, rerun.size > 0 ? rerun : undefined).catch(() => undefined)
      }
    }
  }

  private async pass(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): Promise<void> {
    const senderSnapshot = this.deps.senderSnapshotReader?.() ?? this.deps.senderSnapshot
    let currentReservedTypes = reservedTypes
    // Each message is offered to each owner once per pass; one it no longer owes waits for an edge.
    const offered = new Set<string>()
    for (;;) {
      const db = this.deps.getDb()
      if (!db) {
        return
      }
      // Earlier sends only when something they wait on moved: a fresh arrival or the next page
      // finds them reserved (stamped delivered), so selection skips them anyway.
      const owner = this.deps.resolveStructuredTarget(mailboxHandle)?.sessionId ?? null
      const { outstanding, resend, released } =
        this.settledState.needsSettling(mailboxHandle, owner) || this.authority.ended(mailboxHandle)
          ? await this.settledState.settle(mailboxHandle, owner, () =>
              mailCustody.settleStructuredMailSends({
                db,
                mailboxHandle,
                host: this.deps.host,
                cliCommand: this.deps.getCliCommand(),
                owed: (sessionId, messageIds) =>
                  this.authority.owedTo(sessionId, mailboxHandle, messageIds)
              })
            )
          : { outstanding: new Set<string>(), resend: [], released: false }
      let target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (!target || this.authority.ended(mailboxHandle)) {
        if (!mailCustody.hasStructuredMailSends(db, mailboxHandle)) {
          // Nothing of it is left in any chat: no edge is owed to it.
          this.parking.unpark(mailboxHandle)
          this.settledState.forget(mailboxHandle)
        }
        if (released) {
          // Mail a chat gave back goes to whoever owns the mailbox now, a terminal included.
          queueMicrotask(() => this.redeliver(mailboxHandle))
        }
        return
      }
      for (const again of resend) {
        const message = db.getMessageById(again.row.message_id)
        if (!message || again.row.session_id !== target.sessionId) {
          continue
        }
        if (
          (await this.admit(db, mailboxHandle, target, message, senderSnapshot, again)) === 'park'
        ) {
          this.parking.park(mailboxHandle, target.sessionId, currentReservedTypes)
          return
        }
      }
      const batch = selectOrchestrationPointerBatch({
        db,
        mailboxHandle,
        waiters: this.deps.getMessageWaiters(mailboxHandle),
        reservedTypes: currentReservedTypes
      }).messages.filter(
        (message) =>
          !outstanding.has(message.id) && !offered.has(`${message.id}:${target?.sessionId}`)
      )
      if (batch.length === 0) {
        if (mailCustody.hasStructuredMailSends(db, mailboxHandle)) {
          // Cards still in the chat: their handover or deletion is read on this session's next edge.
          this.parking.park(mailboxHandle, target.sessionId, currentReservedTypes)
        } else {
          this.parking.unpark(mailboxHandle)
          this.settledState.forget(mailboxHandle)
        }
        return
      }
      for (const message of batch) {
        // Whoever owns the mailbox now: a takeover during one send moves the rest of the batch.
        target = this.deps.resolveStructuredTarget(mailboxHandle)
        if (!target) {
          return
        }
        if (offered.has(`${message.id}:${target.sessionId}`)) {
          continue
        }
        offered.add(`${message.id}:${target.sessionId}`)
        // Parked first, so a send that throws is retried on this session's next journal edge.
        this.parking.park(mailboxHandle, target.sessionId, currentReservedTypes)
        if ((await this.admit(db, mailboxHandle, target, message, senderSnapshot)) === 'park') {
          // An edge during the send may have taken the entry; the refusal still waits for the next one.
          this.parking.park(mailboxHandle, target.sessionId, currentReservedTypes)
          return
        }
      }
      // The arrival snapshot protects its first handoff; successors derive live waiter ownership.
      currentReservedTypes = undefined
    }
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async admit(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    message: MessageRow,
    senderSnapshot: SenderSnapshotResolver,
    again?: mailCustody.StructuredMailResend
  ): Promise<AdmitStep> {
    const sessionId = target.sessionId
    const fence = this.deps.host.currentFence(sessionId)
    if (fence === null) {
      return 'park'
    }
    const { body } = structuredMailMessage({
      db,
      mailboxHandle,
      dispatchId: target.dispatchId,
      message,
      cliCommand: this.deps.getCliCommand(),
      senderSnapshot
    })
    const attempt: StructuredMailSendRow = {
      mailbox_handle: mailboxHandle,
      message_id: message.id,
      session_id: sessionId,
      operation_id:
        again && !again.renew ? again.row.operation_id : mintAgentSessionOperationId(Date.now()),
      minted_at_ms: again && !again.renew ? again.row.minted_at_ms : Date.now()
    }
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
      stillOwed: () => {
        last.owed = this.authority.owedTo(sessionId, mailboxHandle, [message.id])
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
    switch (outcome.kind) {
      case 'unattached':
      case 'refused':
        // Refused before admission (a full queue, a detached chat): retry on the session's next edge.
        db.releaseStructuredMailSend(attempt)
        return 'park'
      case 'obsolete':
        db.releaseStructuredMailSend(attempt)
        return last.owed === 'unavailable' ? 'park' : 'next'
      case 'queued':
        return 'next'
      case 'sent':
        // In doubt, including a resend the host answered from an earlier admission: never again.
        if (outcome.state === 'accepted' || outcome.state === 'unknown') {
          const observed = await mailCustody.observeStructuredMailAttempt(this.deps.host, attempt)
          mailCustody.settleStructuredMailAttempt(db, attempt, observed, () =>
            this.authority.owedTo(sessionId, mailboxHandle, [message.id])
          )
        }
        // Pending or rejected: the record decides on a later pass.
        return 'next'
    }
  }

  private redeliver(mailboxHandle: string): void {
    const redeliver = this.deps.redeliver ?? ((handle: string) => this.deliverForHandle(handle))
    redeliver(mailboxHandle)
  }
}
