/**
 * The mail lane for agents that ARE a structured agent session: each orchestration message is
 * sent to the chat whole, as its own message, when it arrives.
 *
 * The PTY lane types a "you have mail, run `check`" pointer into a live pane, because typing the
 * mail itself there collided with a person's half-typed text. A chat has no shared input box: the
 * message goes through the chat's own send, as a person's message does, and the retry edge is the
 * journal. So this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a branch
 * inside it; only batch selection is shared.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts delivery, but a structured coordinator is a chat session
 * whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  hasUnfilteredOrchestrationWaiter,
  shouldReleaseOrchestrationPointer,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import { visitStructuredMailboxPages } from './structured-mailbox-pointer-batch'
import {
  pruneStructuredMailOperations,
  type StructuredMailOperationOwner
} from './structured-mail-operation-owners'
import {
  indexStructuredMailSubmissions,
  type StructuredMailSubmission
} from './structured-pointer-operation-id'
import { sendStructuredMailboxPage } from './structured-mailbox-message-delivery'
import type { SenderNameResolver } from './agent-message-sender'
import type {
  StructuredDispatchState,
  StructuredPointerRetainReason
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
  /** The chat's queue took it, as it takes a person's message. */
  | { kind: 'queued' }
  | { kind: 'unattached' }
  /** Refused at admission: a prompt waits on the person. */
  | { kind: 'held' }

export type StructuredPointerSessionFacts = {
  /** Current-context sends and accepted queue receipts for the lane's mail. */
  submissions: readonly StructuredMailSubmission[]
}

export type StructuredMailboxPointerHost = {
  /** `null` when the session cannot be read. */
  readSessionFacts: (sessionId: string) => Promise<StructuredPointerSessionFacts | null>
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    expectedRuntimeFence: number
    /** Names its senders as `from`. */
    body: AgentJournalMessageItem
    /** The host answered; the send may still be waiting for the agent to take it in. */
    onAnswered?: (attached?: boolean) => void
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
  currentContextClearOperationId: (sessionId: string) => string | undefined
  /** Whether a prompt waits on the person right now; null when the session cannot be read. */
  hasActionablePromptNow: (sessionId: string) => boolean | null
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
  /** The CLI name the PTY lane types for a local agent, so both lanes name the same command. */
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

// Liveness is recorded when a heartbeat arrives; sending each beat would interrupt the chat. Left
// unread for `check`, which (or the worker's report) clears it.
const NATIVE_LANE_SKIPPED_TYPES = ['heartbeat'] as const

export class OrchestrationStructuredMailboxPointerDelivery<
  TWaiter extends OrchestrationMessageWaiter
> {
  private readonly inFlight = new Map<string, StructuredPointerTarget>()
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
  /** Messages whose send is still waiting on its outcome, by `mintedOperations` key. */
  private readonly sendsInFlight = new Map<string, StructuredPointerTarget>()
  /** Mail that arrived while its mailbox's pass ran; the pass runs once more for it. */
  private readonly redeliver = new Map<string, ParkedPointerDelivery>()
  /**
   * The id this process minted per message and session context, until the message is received
   * (including when a `check` receives it instead). A journal send under any other id outlived the
   * process that minted it. A fact, not a clock reading, so no clock step can fake it.
   */
  private readonly mintedOperations = new Map<string, StructuredMailOperationOwner>()

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
    for (const [key, owner] of this.mintedOperations) {
      if (owner.sessionId === sessionId) {
        this.mintedOperations.delete(key)
      }
    }
    for (const state of [this.inFlight, this.sendsInFlight]) {
      for (const [key, target] of state) {
        if (target.sessionId === sessionId) {
          state.delete(key)
        }
      }
    }
    for (const [mailbox, parked] of this.redeliver) {
      if (parked.sessionId === sessionId) {
        this.redeliver.delete(mailbox)
      }
    }
  }

  private prune(db: OrchestrationDb, mailboxHandle: string, key?: string): void {
    pruneStructuredMailOperations({
      db,
      mailboxHandle,
      target: this.deps.resolveStructuredTarget(mailboxHandle),
      host: this.deps.host,
      operations: this.mintedOperations,
      sendsInFlight: this.sendsInFlight,
      key
    })
  }

  private async deliver(
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes?: ReadonlySet<string>,
    attemptedContexts = new Set<string>()
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db) {
      return
    }
    if (this.inFlight.has(mailboxHandle)) {
      const pending = this.redeliver.get(mailboxHandle)?.reservedTypes ?? []
      this.redeliver.set(mailboxHandle, {
        sessionId: target.sessionId,
        reservedTypes: new Set([...pending, ...(reservedTypes ?? [])])
      })
      return
    }
    // The consumer's own unacknowledged batch holds this exact mailbox until it acks.
    if (db.hasOutstandingMailboxDelivery?.(mailboxHandle)) {
      return
    }
    this.prune(db, mailboxHandle)
    const laneExcludedTypes = new Set([...(reservedTypes ?? []), ...NATIVE_LANE_SKIPPED_TYPES])
    const first = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters: this.deps.getMessageWaiters(mailboxHandle),
      reservedTypes: laneExcludedTypes
    })
    if (first.length === 0) {
      return
    }
    const throughSequence = db.getInbox(1)[0]?.sequence
    if (throughSequence === undefined) {
      return
    }
    this.inFlight.set(mailboxHandle, target)
    // Parked before the first await, so a journal edge during the reads is not lost.
    this.parkedUntilJournalEdge.set(mailboxHandle, { sessionId: target.sessionId, reservedTypes })
    let retained = false
    const retain = (reason: StructuredPointerRetainReason) => {
      retained = true
      this.retain(mailboxHandle, target.sessionId, reason, reservedTypes)
    }
    let contextKey: string | undefined
    try {
      const session = await this.deps.host.readSessionFacts(target.sessionId)
      const contextClearOperationId = this.deps.host.currentContextClearOperationId(
        target.sessionId
      )
      contextKey = JSON.stringify([target.sessionId, contextClearOperationId])
      if (this.inFlight.get(mailboxHandle) !== target || attemptedContexts.has(contextKey)) {
        return
      }
      attemptedContexts.add(contextKey)
      const fence = session ? this.deps.host.currentFence(target.sessionId) : null
      if (!session || fence === null) {
        retain('session-not-attached')
        return
      }
      const submissionIndex = indexStructuredMailSubmissions(session.submissions)
      const isCurrent = () =>
        !db.hasOutstandingMailboxDelivery?.(mailboxHandle) &&
        !hasUnfilteredOrchestrationWaiter(this.deps.getMessageWaiters(mailboxHandle)) &&
        this.inFlight.get(mailboxHandle) === target &&
        this.deps.resolveStructuredTarget(mailboxHandle)?.sessionId === target.sessionId &&
        this.deps.host.currentContextClearOperationId(target.sessionId) === contextClearOperationId
      await visitStructuredMailboxPages({
        db,
        mailboxHandle,
        reservedTypes: laneExcludedTypes,
        throughSequence,
        getWaiters: () => this.deps.getMessageWaiters(mailboxHandle),
        isCurrent,
        attempt: (unread) =>
          sendStructuredMailboxPage({
            ...this.deps,
            db,
            mailboxHandle,
            target,
            unread,
            session,
            contextClearOperationId,
            submissionIndex,
            fence,
            isCurrent,
            isEligible: (message) =>
              !shouldReleaseOrchestrationPointer(
                db,
                mailboxHandle,
                [message],
                this.deps.getMessageWaiters(mailboxHandle)
              ),
            retain,
            prune: (key) => this.prune(db, mailboxHandle, key),
            mintedOperations: this.mintedOperations,
            sendsInFlight: this.sendsInFlight
          })
      })
      if (
        !retained &&
        this.parkedUntilJournalEdge.get(mailboxHandle)?.sessionId === target.sessionId
      ) {
        this.parkedUntilJournalEdge.delete(mailboxHandle)
      }
    } finally {
      if (this.inFlight.get(mailboxHandle) === target) {
        this.inFlight.delete(mailboxHandle)
        this.prune(db, mailboxHandle)
        if (contextKey !== undefined) {
          await this.followChangedContext(
            mailboxHandle,
            target,
            reservedTypes,
            attemptedContexts
          ).catch(() => undefined)
        }
        await this.followArrivedMail(mailboxHandle).catch(() => undefined)
      }
    }
  }

  private async followArrivedMail(mailboxHandle: string): Promise<void> {
    const reservedTypes = this.redeliver.get(mailboxHandle)?.reservedTypes
    const current = reservedTypes && this.deps.resolveStructuredTarget(mailboxHandle)
    this.redeliver.delete(mailboxHandle)
    if (current) {
      await this.deliver(mailboxHandle, current, reservedTypes)
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

  /**
   * No `markAsUndelivered` is owed: a message is marked received only after an accepted dispatch,
   * or once the chat's queue holds it.
   *
   * Every reason parks for the session's next journal edge. `unknown` may mean the message already
   * sits in the provider's input queue, so an immediate retry can stack duplicates;
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
