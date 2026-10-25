/**
 * The pointer-delivery lane for workers that ARE a structured agent session.
 *
 * The PTY lane types the nudge into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection and the pointer text are literally shared, and everything
 * below it is different — the nudge goes through the chat's own send, as a person's message does,
 * and the retry edge is the journal.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts pointer delivery, but a structured coordinator is a chat
 * session whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { MessageRow, OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  resolveStructuredPointerOperation,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
import { structuredMailSource } from './structured-mail-source'
import type { SenderNameResolver } from './agent-message-sender'
import {
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredDispatchState,
  type StructuredPointerRetainReason
} from './structured-session-pointer-delivery'

export type StructuredPointerTarget = {
  sessionId: string
  /**
   * The dispatch whose mailbox this is, or null for direct peer mail addressed to the worker's own
   * handle outside any dispatch. Nothing downstream needs a dispatch to deliver — it only names
   * the caller on the operation row and the mail's source — so a worker between dispatches is
   * nudged, not dropped.
   */
  dispatchId: string | null
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'held' }
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued' }
  | { kind: 'unattached' }

export type StructuredPointerSessionFacts = {
  /** Current-context sends, oldest first: what the lane's own sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
}

export type StructuredMailboxPointerHost = {
  /** `null` when the session cannot be read. */
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  hasActionablePromptNow: (sessionId: string) => boolean | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * The mailbox is a `dispatch:` address or the worker's own bearer handle; the second is how
   * agents mail each other outside a dispatch, and no other lane can serve it.
   */
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
  /**
   * Mailboxes whose retry must wait for the session's next journal edge, each remembering the
   * session it is parked ON.
   *
   * Recorded rather than re-resolved: `resolveStructuredTarget` answers null whenever the runtime
   * cannot look — a momentarily null DB reference, a session mid-teardown — and pruning on that
   * absence dropped every OTHER worker's parked entry too, silently costing them their wake-up
   * edge until the next explicit check.
   */
  private readonly parkedUntilJournalEdge = new Map<string, ParkedPointerDelivery>()
  /** The operation id this lane last sent per mailbox: a row holding any other id outlived the
   *  process that minted it. A fact, not a clock reading, so no clock step can fake it. */
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

  /** The session's journal moved — a turn settled, or a re-attach replayed it; retry what is
   *  parked on that edge. */
  onJournalActivity(sessionId: string): void {
    for (const [mailboxHandle, parked] of Array.from(this.parkedUntilJournalEdge)) {
      if (parked.sessionId !== sessionId) {
        continue
      }
      this.parkedUntilJournalEdge.delete(mailboxHandle)
      const target = this.deps.resolveStructuredTarget(mailboxHandle)
      if (target?.sessionId !== sessionId) {
        // The mailbox moved off this session (or cannot be resolved right now); its own edge or an
        // explicit check is what retries it, not this session's journal.
        continue
      }
      void this.deliver(mailboxHandle, target, parked.reservedTypes).catch(() => undefined)
    }
  }

  /**
   * The worker settled; drop what IT had parked, and nothing else.
   *
   * The recorded session id is the whole test. Settlement forgets the worker's identity, so
   * re-resolving the target here would answer null for exactly the entries this is meant to
   * prune — and null for every sibling the runtime momentarily cannot resolve either.
   */
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
        // The consumer's own unacknowledged batch suppresses nudges only for this exact mailbox.
        if (!db || db.hasOutstandingMailboxDelivery?.(mailboxHandle)) {
          return
        }
        const unread = selectOrchestrationPointerBatch({
          db,
          mailboxHandle,
          waiters: this.deps.getMessageWaiters(mailboxHandle),
          reservedTypes: currentReservedTypes
        })
        if (unread.length === 0) {
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
          unread,
          currentReservedTypes,
          session,
          contextClearOperationId
        )
        while (
          attempt === 'held' &&
          this.deps.host.hasActionablePromptNow(current.sessionId) === false
        ) {
          attempt = await this.attempt(
            db,
            mailboxHandle,
            current,
            unread,
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
        // Acceptance releases the snapshotted batch; rederive any mail that arrived meanwhile.
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
    unread: readonly MessageRow[],
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
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [
        {
          type: 'text',
          text: formatMessagePointer(unread.length, mailboxHandle, this.deps.getCliCommand()).trim()
        }
      ],
      from: structuredMailSource({
        db,
        mailboxHandle,
        dispatchId: target.dispatchId,
        batch: unread,
        senderName: this.deps.senderName
      })
    }
    const staged = unread.map((message) => message.id)
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
      body
    })
    if (outcome.kind === 'held') {
      return 'held'
    }
    if (outcome.kind === 'unattached') {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return false
    }
    // A queued pointer is the chat's queue's to send, as a person's queued message is.
    if (outcome.kind === 'sent' && !structuredDispatchDelivered(outcome.state)) {
      // The row stays: resending under its id replays this verdict and starts nothing.
      this.retain(mailboxHandle, sessionId, retainReasonForDispatch(outcome.state), reservedTypes)
      return false
    }
    db.markAsDelivered(staged, mailboxHandle)
    db.deleteStructuredPointerOperation(mailboxHandle)
    this.sentOperationIds.delete(mailboxHandle)
    return true
  }

  /**
   * No `markAsUndelivered` is owed: rows are marked delivered only after an accepted dispatch, or
   * once the chat's queue holds the pointer.
   *
   * Every reason parks for the session's next journal edge. `unknown` may mean the nudge already
   * sits in the provider's input queue, so an immediate retry can stack duplicate nudges;
   * `session-not-attached` and `dispatch-rejected` park because nothing else notices the re-attach
   * or the moved lease, and the dispatch preamble tells workers not to poll.
   */
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
