/** Chat sessions get each orchestration message whole, as its own ordinary message: the chat's queue holds it
 *  behind running work or a question, and the agent is handed one per turn. Terminals keep the PTY pointer lane. */

import type { MessageRow, OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import { mintAgentSessionOperationId } from './structured-pointer-operation-id'
import type { StructuredMailboxPointerHost } from './structured-mailbox-pointer-host-contract'
import { structuredMailMessage } from './structured-mail-source'
import type { SenderSnapshotResolver } from './agent-message-sender'
import type { StructuredMailSendRow } from './db/messages/structured-mail-send-store'
import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import {
  orchestrationMailNotice,
  type AgentMessageSource
} from '../../../shared/agent-session/agent-session-message-source'
import { StructuredMailboxParking } from './structured-mailbox-parking'
import { StructuredMailSettledState } from './structured-mail-settled-state'
import {
  hasStructuredMailSends,
  settleStructuredMailSends,
  StructuredMailAuthority,
  type StructuredMailResend
} from './structured-mail-custody'

export type StructuredPointerTarget = {
  sessionId: string
  /** Direct peer mail has no Dispatch; that absence must not prevent worker nudges. */
  dispatchId: string | null
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /** Resolve dispatch or direct-worker mail to its session; null delegates to the PTY lane. */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  /** The runtime's own delivery for a mailbox, whichever lane owns it: a terminal's included. */
  redeliver?: (mailboxHandle: string) => void
  /** Whether nothing can own the mailbox again; read from the database unless a test supplies it. */
  mailboxEnded?: (mailboxHandle: string) => boolean
  /** Why no chat resolves a mailbox; read from the database unless a test supplies it. */
  unresolvedCustody?: (mailboxHandle: string) => 'elsewhere' | 'unverifiable'
  /** The CLI name the recipient runs, for the reply line and the oversized-message pointer. */
  getCliCommand: () => OrchestrationCliCommand
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderSnapshot: SenderSnapshotResolver
  host: StructuredMailboxPointerHost
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

  private readonly authority: StructuredMailAuthority
  private readonly settledState = new StructuredMailSettledState()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {
    this.authority = new StructuredMailAuthority({ ...deps, resolve: deps.resolveStructuredTarget })
  }

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    // Earlier sends are settled even when no chat owns the mailbox now; only an owner is sent to.
    if (!target && !hasStructuredMailSends(this.deps.getDb(), mailboxHandle)) {
      // Nothing to settle or send: keep nothing for it. A pass still running forgets it itself, after
      // it has seen what this cleanup marked.
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
    db: OrchestrationDb | null
  ): QueuedMessageOwed {
    return this.authority.owedNow(sessionId, from, db)
  }

  /** The queue asks this as it hands an agent's card over. A stale mail card is dropped without a
   *  turn, so its record is settled here: the deletion is never read later as the person's, and
   *  mail still in this mailbox goes to its new owner. */
  owedAtHandover(
    sessionId: string,
    from: AgentMessageSource,
    db: OrchestrationDb | null
  ): QueuedMessageOwed {
    const owed = this.owedNow(sessionId, from, db)
    const mail = orchestrationMailNotice(from)
    if (owed === 'stale' && mail && db) {
      for (const { messageId } of mail.messages) {
        const row = db.getStructuredMailSend(mail.mailbox, messageId)
        if (row?.session_id === sessionId) {
          db.releaseStructuredMailSend(row)
        }
      }
      // After the queue's write lane unwinds, through whichever lane owns the mailbox now.
      this.settledState.invalidate(mail.mailbox)
      queueMicrotask(() => this.redeliver(mail.mailbox))
    }
    return owed
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
              settleStructuredMailSends({
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
        if (!hasStructuredMailSends(db, mailboxHandle)) {
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
        if ((await this.admit(db, mailboxHandle, target, message, again)) === 'park') {
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
        if (hasStructuredMailSends(db, mailboxHandle)) {
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
        if ((await this.admit(db, mailboxHandle, target, message)) === 'park') {
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
    again?: StructuredMailResend
  ): Promise<AdmitStep> {
    const sessionId = target.sessionId
    const fence = this.deps.host.currentFence(sessionId)
    if (fence === null) {
      return 'park'
    }
    const { body, whole } = structuredMailMessage({
      db,
      mailboxHandle,
      dispatchId: target.dispatchId,
      message,
      cliCommand: this.deps.getCliCommand(),
      senderSnapshot: this.deps.senderSnapshot
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
          db.retireStructuredMailSend(attempt, outcome.state === 'accepted' && whole)
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
