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

export type StructuredPointerTarget = {
  sessionId: string
  /** Direct peer mail has no Dispatch; that absence must not prevent worker nudges. */
  dispatchId: string | null
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /** Resolve dispatch or direct-worker mail to its session; null delegates to the PTY lane. */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
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
  /** Retain the parked session id: transient resolution failure must not erase unrelated workers' retry edges. */
  private readonly parkedUntilJournalEdge = new Map<string, ParkedPointerDelivery>()

  constructor(private readonly deps: StructuredPointerDeliveryDependencies<TWaiter>) {}

  deliverForHandle(mailboxHandle: string, reservedTypes?: ReadonlySet<string>): boolean {
    const target = this.deps.resolveStructuredTarget(mailboxHandle)
    if (!target) {
      return false
    }
    void this.deliver(mailboxHandle, target, reservedTypes).catch(() => {
      // Durable mail stays available to an explicit check or the next settle edge.
    })
    return true
  }

  /** Retry mail parked on this session's settlement or reattach journal edge. */
  onJournalActivity(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId !== sessionId) {
        continue
      }
      this.parkedUntilJournalEdge.delete(mailboxHandle)
      const target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (target?.sessionId !== sessionId) {
        // This journal cannot wake a mailbox moved elsewhere or currently unresolved; retain its own retry edge.
        continue
      }
      void this.deliver(mailboxHandle, target, parked.reservedTypes).catch(() => undefined)
    }
  }

  /** Prune only this recorded session; settlement removes resolver identity and transient nulls also affect siblings. */
  forgetSession(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId === sessionId) {
        this.parkedUntilJournalEdge.delete(mailboxHandle)
      }
    }
  }

  /** A check consumed, or a move re-addressed, mail whose card still waits: delete the card so the
   *  agent is not handed it a second time. A card that cannot be deleted now is retried on the next pass. */
  async withdrawTaken(): Promise<void> {
    const db = this.deps.getDb()
    for (const row of db?.getTakenStructuredMailSends() ?? []) {
      await this.withdraw(db!, row)
    }
  }

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    if (this.inFlight.has(mailboxHandle)) {
      return
    }
    this.inFlight.add(mailboxHandle)
    let current = target
    let currentReservedTypes = reservedTypes
    try {
      for (;;) {
        const db = this.deps.getDb()
        if (!db) {
          return
        }
        const sent = await this.observe(db, mailboxHandle)
        const batch = selectOrchestrationPointerBatch({
          db,
          mailboxHandle,
          waiters: this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes: currentReservedTypes
        }).messages.filter((message) => !sent.has(message.id))
        if (batch.length === 0) {
          if (sent.size > 0) {
            // Cards still in the chat: their handover or deletion is read on this session's next edge.
            this.park(mailboxHandle, current.sessionId, currentReservedTypes)
          }
          return
        }
        for (const message of batch) {
          if ((await this.admit(db, mailboxHandle, current, message)) === 'park') {
            this.park(mailboxHandle, current.sessionId, currentReservedTypes)
            return
          }
        }
        // The arrival snapshot protects its first handoff; successors derive live waiter ownership.
        currentReservedTypes = undefined
        const next = this.deps.resolveStructuredTarget(mailboxHandle)
        if (!next) {
          return
        }
        current = next
      }
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
  }

  /** Settle what became of earlier sends; returns the ids still in a chat's hands. */
  private async observe(db: OrchestrationDb, mailboxHandle: string): Promise<Set<string>> {
    const outstanding = new Set<string>()
    for (const row of db.getStructuredMailSends(mailboxHandle)) {
      const message = db.getMessageById(row.message_id)
      if (!message || message.read || message.to_handle !== mailboxHandle) {
        if (!(await this.withdraw(db, row))) {
          outstanding.add(row.message_id)
        }
        continue
      }
      const state = await this.deps.host.observe(row.session_id, row.operation_id)
      if (state === 'waiting' || state === 'unreadable') {
        if (!message.delivered_at) {
          // The send landed but its stamp did not: the chat holds it, so selection must skip it.
          db.markAsDelivered([message.id], mailboxHandle)
        }
        outstanding.add(row.message_id)
        continue
      }
      if (state === 'handed') {
        db.markAsReadAndDelivered([message.id])
      } else if (state === 'lost') {
        // Rejected or unanswered: `check` still returns it, and this lane does not loop on it.
        db.markAsDelivered([message.id], mailboxHandle)
      }
      // 'absent': nothing landed, so an undelivered message is admitted again under a new id.
      db.deleteStructuredMailSend(mailboxHandle, row.message_id)
    }
    return outstanding
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async admit(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    message: MessageRow
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
    const operationId = mintAgentSessionOperationId(Date.now())
    // Recorded before the send, so a crash after it lands still finds the card instead of sending twice.
    // A pointer for a message too large to send whole leaves the message for `check`; nothing to follow.
    if (whole) {
      db.putStructuredMailSend({
        mailbox_handle: mailboxHandle,
        message_id: message.id,
        session_id: sessionId,
        operation_id: operationId,
        minted_at_ms: Date.now()
      })
    }
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId,
      expectedRuntimeFence: fence,
      body,
      stillOwed: () =>
        !shouldReleaseOrchestrationPointer(
          this.deps.getDb(),
          mailboxHandle,
          [message],
          this.deps.getMessageWaiters(mailboxHandle)
        )
    })
    const forget = () => whole && db.deleteStructuredMailSend(mailboxHandle, message.id)
    switch (outcome.kind) {
      case 'unattached':
      case 'refused':
        // Nothing was recorded (a full queue, a detached chat): retry on the session's next edge.
        forget()
        return 'park'
      case 'obsolete':
        forget()
        return 'next'
      case 'queued':
        db.markAsDelivered([message.id], mailboxHandle)
        return 'next'
      case 'sent':
        if (outcome.state === 'accepted' && whole) {
          db.markAsReadAndDelivered([message.id])
          forget()
          return 'next'
        }
        db.markAsDelivered([message.id], mailboxHandle)
        if (outcome.state !== 'pending') {
          forget()
        }
        return 'next'
    }
  }

  private async withdraw(db: OrchestrationDb, row: StructuredMailSendRow): Promise<boolean> {
    if (!(await this.deps.host.withdraw(row.session_id, row.operation_id))) {
      return false
    }
    db.deleteStructuredMailSend(row.mailbox_handle, row.message_id)
    return true
  }

  private park(
    mailboxHandle: string,
    sessionId: string,
    reservedTypes: ReadonlySet<string> | undefined
  ): void {
    this.parkedUntilJournalEdge.set(mailboxHandle, { sessionId, reservedTypes })
  }
}
