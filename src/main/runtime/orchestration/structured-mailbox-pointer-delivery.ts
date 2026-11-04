import { StructuredMailAdmission } from './structured-mail-admission'
/** Chat sessions get each orchestration message whole, as its own ordinary message: the chat's queue holds it
 *  behind running work or a question, and the agent is handed one per turn. Terminals keep the PTY pointer lane. */

import type { OrchestrationDb } from './db'
import { selectOrchestrationPointerBatch } from './mailbox-pointer-eligibility'
import type { OrchestrationMessageWaiter } from './mailbox-pointer-eligibility'
import type { StructuredMailDeliveryCause } from './structured-mailbox-pointer-host-contract'

import type { QueuedMessageOwed } from '../../native-chat/agent-session-journal/queued-message-consume-error'
import {
  orchestrationMailNotice,
  type AgentMessageSource
} from '../../../shared/agent-session/agent-session-message-source'
import { StructuredMailboxParking } from './structured-mailbox-parking'
import { StructuredMailSettledState } from './structured-mail-settled-state'
import { StructuredMailDiscovery } from './structured-mail-discovery'
import { hasStructuredMailSends, StructuredMailAuthority } from './structured-mail-custody'

import type { StructuredPointerDeliveryDependencies } from './structured-mailbox-delivery-contract'
export type { StructuredPointerTarget } from './structured-mailbox-delivery-contract'

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

  private readonly discovery = new StructuredMailDiscovery()
  private readonly admission: StructuredMailAdmission<TWaiter>
  private readonly authority: StructuredMailAuthority
  private readonly settledState = new StructuredMailSettledState()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {
    this.authority = new StructuredMailAuthority({ ...deps, resolve: deps.resolveStructuredTarget })
    this.admission = new StructuredMailAdmission({
      ...deps,
      authority: this.authority,
      parking: this.parking,
      discover: (mailbox) => this.discover(mailbox),
      redeliver: (mailbox) => this.redeliver(mailbox)
    })
  }

  deliverForHandle(
    mailboxHandle: string,
    reservedTypes?: ReadonlySet<string>,
    cause: StructuredMailDeliveryCause = 'discovery'
  ): boolean {
    if (cause === 'discovery') {
      this.discover(mailboxHandle)
    }
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    // Earlier sends are settled even when no chat owns the mailbox now; only an owner is sent to.
    if (!target && !hasStructuredMailSends(this.deps.getDb(), mailboxHandle)) {
      // Nothing to settle or send: keep nothing for it. A pass still running forgets it itself, after
      // it has seen what this cleanup marked.
      if (!this.inFlight.has(mailboxHandle)) {
        this.settledState.forget(mailboxHandle)
        this.discovery.forget(mailboxHandle)
        this.parking.unpark(mailboxHandle)
      }
      return false
    }
    void this.deliver(mailboxHandle, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
    })
    return target !== null
  }

  /** Record the event now; deferred redrives only service this pending discovery. */
  discover(mailboxHandle: string): void {
    this.discovery.request(mailboxHandle)
  }

  reset(): void {
    this.admission.reset()
    this.discovery.clear()
    this.parking.clear()
    this.settledState.clear()
    this.rerun.clear()
  }

  /** Retry mail parked on this session's settlement or reattach journal edge. */
  onJournalActivity(sessionId: string): void {
    // The watch stays through its own redrive: only a move, or the last obligation ending, ends it.
    for (const [mailboxHandle] of this.parking.parkedFor(sessionId)) {
      this.settledState.invalidate(mailboxHandle)
      void this.deliver(mailboxHandle).catch(() => undefined)
    }
  }

  /** Whether a status callback is news to this session's mail; see StructuredMailSettledState. */
  statusChanged(sessionId: string, status: string | null): boolean {
    const fence = this.deps.host.currentFence(sessionId)
    return this.settledState.statusChanged(sessionId, status, fence)
  }

  /** Prune only this recorded session; settlement removes resolver identity and transient nulls also affect siblings. */
  forgetSession(sessionId: string): void {
    for (const [mailbox] of this.parking.parkedFor(sessionId)) {
      this.discovery.forget(mailbox)
    }
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
  withdrawStale(
    mailboxes?: Iterable<string>,
    cause: StructuredMailDeliveryCause = 'service'
  ): void {
    let scope: Iterable<string>
    try {
      scope = mailboxes ?? this.deps.getDb()?.getStructuredMailSendMailboxes() ?? []
    } catch {
      // A database closing under shutdown has no cards left to settle.
      return
    }
    for (const mailboxHandle of scope) {
      this.settledState.invalidate(mailboxHandle)
      this.deliverForHandle(mailboxHandle, undefined, cause)
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
          if (db.releaseStructuredMailSend(row)) {
            this.admission.released(db, row)
          }
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
    const walk = this.discovery.get(mailboxHandle)
    walk.protect(reservedTypes)
    const db = this.deps.getDb()
    if (!db) {
      return
    }
    this.admission.flushReleaseHints()
    if (db.db?.isTransaction) {
      this.deps.scheduleRedelivery?.(mailboxHandle)
      return
    }
    let target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (target) {
      this.parking.park(mailboxHandle, target.sessionId, reservedTypes)
    }
    const owner = target?.sessionId ?? null
    const { resend, released } = await this.settledState.settleMailbox(
      mailboxHandle,
      owner,
      this.authority.ended(mailboxHandle),
      {
        db,
        mailboxHandle,
        host: this.deps.host,
        cliCommand: this.deps.getCliCommand(),
        owed: (sessionId, ids) => this.authority.owedTo(sessionId, mailboxHandle, ids),
        onReleased: (row) => this.admission.released(db, row)
      }
    )
    if (!this.discovery.owns(mailboxHandle, walk) || db !== this.deps.getDb()) {
      return
    }
    target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (released) {
      this.discover(mailboxHandle)
    }
    if (!target || this.authority.ended(mailboxHandle)) {
      if (!hasStructuredMailSends(db, mailboxHandle)) {
        this.parking.unpark(mailboxHandle)
        this.discovery.forget(mailboxHandle)
        this.settledState.forget(mailboxHandle)
      }
      if (released) {
        queueMicrotask(() => this.redeliver(mailboxHandle))
      }
      return
    }
    const reconcile = () =>
      this.discovery.reconcile(mailboxHandle, walk, {
        ...this.deps,
        db,
        parking: this.parking,
        reservedTypes,
        retrying: resend.length > 0
      })
    for (const again of resend) {
      const current = await reconcile()
      if (!current) {
        return
      }
      const message = db.getMessageById(again.row.message_id)
      if (!message || again.row.session_id !== current.target.sessionId) {
        continue
      }
      const step = await this.admission.admit(
        db,
        mailboxHandle,
        current.target,
        message,
        walk,
        again
      )
      if (step === 'park') {
        this.settledState.invalidate(mailboxHandle)
        return
      }
    }
    for (;;) {
      const current = await reconcile()
      if (!current) {
        return
      }
      if (!walk.pending) {
        break
      }
      if (walk.page.length === 0) {
        const page = selectOrchestrationPointerBatch({
          db,
          mailboxHandle,
          waiters: this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes: walk.reservedTypes,
          afterSequence: walk.afterSequence
        })
        walk.page = page.messages
        if (walk.page.length === 0) {
          walk.complete()
          break
        }
      }
      const message = walk.page[0]
      if (!message) {
        continue
      }
      const generation = walk.generation
      const step = await this.admission.admit(db, mailboxHandle, current.target, message, walk)
      if (!this.discovery.owns(mailboxHandle, walk) || db !== this.deps.getDb()) {
        return
      }
      if (step === 'park') {
        return
      }
      // Reconcile before touching the retained page: a Stop/Resume or arrival may have reset it.
      if (!(await reconcile())) {
        return
      }
      if (walk.generation !== generation) {
        continue
      }
      walk.afterSequence = message.sequence
      walk.page.shift()
      // A first handoff's protected types no longer exclude earlier rows after that handoff.
      if (walk.reservedTypes?.size && step !== 'held') {
        walk.relaxReserved()
      }
    }
    const currentOwner = this.deps.resolveStructuredTarget(mailboxHandle)?.sessionId ?? null
    if (this.settledState.needsSettling(mailboxHandle, currentOwner)) {
      void this.deliver(mailboxHandle, reservedTypes)
    }
    if (!walk.held && !hasStructuredMailSends(db, mailboxHandle)) {
      this.parking.unpark(mailboxHandle)
      this.discovery.forget(mailboxHandle)
      this.settledState.forget(mailboxHandle)
    }
  }

  private redeliver(mailboxHandle: string): void {
    const deliver =
      this.deps.redeliver ??
      ((handle: string) => this.deliverForHandle(handle, undefined, 'service'))
    deliver(mailboxHandle)
  }
}
