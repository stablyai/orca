/** Structured workers and coordinators need chat sends and journal retry edges; share PTY batch/text policy without requiring PTY input. */

import type { OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter,
  type OrchestrationPointerBatch
} from './mailbox-pointer-eligibility'
import { resolveStructuredPointerOperation } from './structured-pointer-operation-id'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerSessionFacts
} from './structured-mailbox-pointer-host-contract'
import { structuredMailNotice } from './structured-mail-source'
import type { SenderNameResolver } from './agent-message-sender'
import {
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredPointerRetainReason
} from './structured-session-pointer-delivery'

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
  /** The CLI name the PTY lane types for a local agent, so both lanes send the same pointer. */
  getCliCommand: () => OrchestrationCliCommand
  /** What Orca calls a sender now, snapshotted onto the message; null when it has no name. */
  senderName: SenderNameResolver
  host: StructuredMailboxPointerHost
  onRetain?: (input: {
    mailboxHandle: string
    sessionId: string
    reason: StructuredPointerRetainReason
  }) => void
}

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Set<string>()
  /** Retain the parked session id: transient resolution failure must not erase unrelated workers' retry edges. */
  private readonly parkedUntilJournalEdge = new Map<string, ParkedPointerDelivery>()
  /** Track process-owned send ids explicitly so clock changes cannot impersonate ownership. */
  private readonly sentOperationIds = new Map<string, string>()

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

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>,
    attemptedContexts = new Set<string>()
  ): Promise<void> {
    if (this.inFlight.has(mailboxHandle)) {
      return
    }
    this.inFlight.add(mailboxHandle)
    let current = target
    let currentReservedTypes = reservedTypes
    let contextKey: string | undefined
    let progressed = false
    try {
      for (;;) {
        const db = this.deps.getDb()
        if (!db) {
          return
        }
        const batch = selectOrchestrationPointerBatch({
          db,
          mailboxHandle,
          waiters: this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes: currentReservedTypes
        })
        if (batch.messages.length === 0) {
          return
        }
        // A mid-turn steer stamps delivered_at, so one an unacked turn ignores would spend this
        // mail's only nudge; the send's admission rechecks this, as a turn can start meanwhile.
        if (batch.heldDeliveryId && this.deps.host.isWorkingNow(current.sessionId)) {
          this.retain(mailboxHandle, current.sessionId, 'turn-unsettled', currentReservedTypes)
          return
        }
        this.parkedUntilJournalEdge.set(mailboxHandle, {
          sessionId: current.sessionId,
          reservedTypes: currentReservedTypes
        })
        const session = await this.deps.host.readSessionFacts(current.sessionId)
        const contextClearOperationId = this.deps.host.currentContextClearOperationId(
          current.sessionId
        )
        contextKey = JSON.stringify([current.sessionId, contextClearOperationId])
        if (!progressed && attemptedContexts.has(contextKey)) {
          return
        }
        attemptedContexts.add(contextKey)
        let attempt = await this.attempt(
          db,
          mailboxHandle,
          current,
          batch,
          currentReservedTypes,
          session,
          contextClearOperationId
        )
        while (
          attempt === 'held' &&
          this.deps.host.hasActionablePromptNow(current.sessionId) === false &&
          !(batch.heldDeliveryId && this.deps.host.isWorkingNow(current.sessionId))
        ) {
          attempt = await this.attempt(
            db,
            mailboxHandle,
            current,
            batch,
            currentReservedTypes,
            session,
            contextClearOperationId
          )
        }
        if (attempt === 'held') {
          this.retain(mailboxHandle, current.sessionId, 'turn-unsettled', currentReservedTypes)
          return
        }
        progressed = attempt
        if (!progressed) {
          return
        }
        // The arrival snapshot protects its first handoff; successors derive live waiter ownership.
        currentReservedTypes = undefined
        // After acceptance, release the old snapshot and reselect any newer mail.
        this.parkedUntilJournalEdge.delete(mailboxHandle)
        const next = this.deps.resolveStructuredTarget(mailboxHandle)
        if (!next) {
          return
        }
        current = next
      }
    } finally {
      this.inFlight.delete(mailboxHandle)
      // A thrown attempt follows too; its own failure is what still propagates.
      if (contextKey !== undefined) {
        await this.followChangedContext(
          mailboxHandle,
          current,
          currentReservedTypes,
          attemptedContexts
        ).catch(() => undefined)
      }
    }
  }

  /** Clear's idle edge can land during a send; retry only a changed context, once per context. */
  private async followChangedContext(
    mailboxHandle: string,
    attempted: StructuredPointerTarget,
    reservedTypes: ReadonlySet<string> | undefined,
    attemptedContexts: Set<string>
  ): Promise<void> {
    const current = this.deps.resolveStructuredTarget(mailboxHandle)
    if (
      !current ||
      attemptedContexts.has(
        JSON.stringify([
          current.sessionId,
          this.deps.host.currentContextClearOperationId(current.sessionId)
        ])
      )
    ) {
      return
    }
    if (this.parkedUntilJournalEdge.get(mailboxHandle)?.sessionId === attempted.sessionId) {
      this.parkedUntilJournalEdge.delete(mailboxHandle)
    }
    await this.deliver(mailboxHandle, current, reservedTypes, attemptedContexts)
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    batch: OrchestrationPointerBatch,
    reservedTypes: ReadonlySet<string> | undefined,
    session: StructuredPointerSessionFacts | null,
    contextClearOperationId: string | undefined
  ): Promise<boolean | 'held'> {
    const sessionId = target.sessionId
    const fence = this.deps.host.currentFence(sessionId)
    if (!session || fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return false
    }
    const body = structuredMailNotice({
      db,
      mailboxHandle,
      dispatchId: target.dispatchId,
      batch,
      cliCommand: this.deps.getCliCommand(),
      senderName: this.deps.senderName
    })
    const staged = batch.messages.map((message) => message.id)
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      messageIds: staged,
      submissions: session.submissions,
      contextClearOperationId,
      sentByThisProcess: this.sentOperationIds.get(mailboxHandle)
    })
    if (operation.kind === 'stamp') {
      // A send this lane gave up waiting on ran after all.
      db.markAsDelivered(staged, mailboxHandle)
      db.deleteStructuredPointerOperation(mailboxHandle)
      this.sentOperationIds.delete(mailboxHandle)
      return true
    }
    if (operation.kind === 'park') {
      this.retain(mailboxHandle, sessionId, 'turn-unsettled', reservedTypes)
      return false
    }
    this.sentOperationIds.set(mailboxHandle, operation.operationId)
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      expectedRuntimeFence: fence,
      body,
      holdWhileWorking: batch.heldDeliveryId !== undefined,
      stillOwed: () =>
        !shouldReleaseOrchestrationPointer(
          this.deps.getDb(),
          mailboxHandle,
          batch.messages,
          this.deps.getMessageWaiters(mailboxHandle)
        )
    })
    if (outcome.kind === 'held') {
      return 'held'
    }
    if (outcome.kind === 'unattached') {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return false
    }
    // A queued pointer belongs to the chat queue; it must not be sent again.
    if (outcome.kind === 'sent' && !structuredDispatchDelivered(outcome.state)) {
      // The row stays: resending under its id replays this verdict and starts nothing.
      this.retain(mailboxHandle, sessionId, retainReasonForDispatch(outcome.state), reservedTypes)
      return false
    }
    // An obsolete notice ran nothing; reselect whatever mail is still owed.
    if (outcome.kind !== 'obsolete') {
      db.markAsDelivered(staged, mailboxHandle)
    }
    db.deleteStructuredPointerOperation(mailboxHandle)
    this.sentOperationIds.delete(mailboxHandle)
    return true
  }

  /** Mark delivered only after accepted dispatch or queue ownership; park every refusal/unknown for a journal edge to avoid duplicate nudges. */
  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason,
    reservedTypes: ReadonlySet<string> | undefined
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
    this.parkedUntilJournalEdge.set(mailboxHandle, { sessionId, reservedTypes })
  }
}
