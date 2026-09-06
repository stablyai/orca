/**
 * The pointer-delivery lane for workers that ARE a structured agent session.
 *
 * The PTY lane types the nudge into a live pane and reads the idle edge off the terminal title.
 * Neither exists here, so this is a sibling of `OrchestrationMailboxPointerDelivery` rather than a
 * branch inside it: batch selection is literally shared (`selectOrchestrationPointerBatch`), and
 * everything below it is different — the nudge is a session turn, the idle edge is the journal,
 * and only an `accepted` dispatch may consume mail.
 *
 * Coordinators are in scope here, unlike the PTY lane's reasoning: a PTY coordinator blocks in
 * `check --wait`, where a waiter preempts pointer delivery, but a structured coordinator is a chat
 * session whose turn ends — so nothing else would ever wake it for its own `run:` mail.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import { resolveStructuredPointerOperation } from './structured-pointer-operation-id'
import {
  decideStructuredPointerDelivery,
  decideStructuredSessionPointerDelivery,
  retainReasonForDispatch,
  retainWaitsForJournalEdge,
  structuredDispatchDelivered,
  type StructuredDispatchState,
  type StructuredPointerRetainReason,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'
import type { AgentSessionPtyWriteRefusal } from '../../../shared/agent-session-pty-write-admission'

export type StructuredPointerTarget = {
  sessionId: string
  /**
   * The dispatch whose mailbox this is, or null for direct peer mail addressed to the worker's own
   * handle outside any dispatch. Nothing downstream needs a dispatch to deliver — it only scopes
   * the operation-ledger budget — so a worker between dispatches is nudged, not dropped.
   */
  dispatchId: string | null
  /** Present only for an adopted pane, where a PTY write was refused in favour of this owner. */
  refusal?: AgentSessionPtyWriteRefusal
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'unattached' }

export type StructuredMailboxPointerHost = {
  /** The idle gate, read off the session's full reduced timeline; `null` when it is not attached. */
  readGateFacts: (sessionId: string) => StructuredSessionGateFacts | null
  send: (input: {
    sessionId: string
    dispatchId: string | null
    operationId: string
    payloadFingerprint: string
    expectedRuntimeFence: number
    body: AgentJournalMessageItem
  }) => Promise<StructuredPointerSendOutcome>
  /** Current lease fence; `null` when no record backs the session any more. */
  currentFence: (sessionId: string) => number | null
}

type StructuredPointerDeliveryDependencies<TWaiter extends OrchestrationMessageWaiter> = {
  getDb: () => OrchestrationDb | null
  getMessageWaiters: (mailboxHandle: string) => ReadonlySet<TWaiter> | undefined
  /**
   * The session a mailbox must be nudged through, or null when a live PTY can take the bytes.
   *
   * Two shapes reach here. A NATIVE-BORN worker carries no refusal: it never had a PTY. An
   * ADOPTED one does — its pane is bound to a session a native owner holds, so the PTY write is
   * refused and the refusal is what proves the owner is settled enough to redirect to.
   *
   * The mailbox is a `dispatch:` address or the worker's own bearer handle; the second is how
   * agents mail each other outside a dispatch, and no other lane can serve it.
   */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
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
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db || this.inFlight.has(mailboxHandle)) {
      return
    }
    // Don't re-nudge a mailbox whose consumer still holds an unacknowledged batch. The lookup is
    // keyed on the exact handle being nudged, so a coordinator's own `run:` delivery is invisible
    // to a worker's `dispatch:` gate and cannot suppress the nudges a coordinator sends its
    // workers. Worth more here than in the PTY lane: a structured nudge costs a whole provider
    // turn, not a line of text into a composer.
    if (db.hasOutstandingMailboxDelivery?.(mailboxHandle)) {
      return
    }
    const unread = selectOrchestrationPointerBatch({
      db,
      mailboxHandle,
      waiters: this.deps.getMessageWaiters(mailboxHandle),
      reservedTypes
    })
    if (unread.length === 0) {
      return
    }
    this.inFlight.add(mailboxHandle)
    try {
      await this.attempt(db, mailboxHandle, target, unread, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
  }

  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    unread: readonly { id: string; type: string; sequence: number }[],
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const session = this.deps.host.readGateFacts(sessionId)
    // `target.refusal` is the snapshot the resolver already admitted, so this branch re-runs the
    // owner test on frozen input and can only agree with it. What actually fences an owner that
    // changed since resolution is `expectedRuntimeFence` below: a handoff bumps the lease fence,
    // so the send is refused rather than landing in a lease on its way back to a TUI. The branch
    // stays because the policy module is the one place that decides, and a later caller may pass
    // an owner it did not pre-screen.
    const decision = target.refusal
      ? decideStructuredPointerDelivery({ session, refusal: target.refusal })
      : decideStructuredSessionPointerDelivery({ session })
    if (!decision.deliver) {
      this.retain(mailboxHandle, sessionId, decision.retain, reservedTypes)
      return
    }
    const fence = this.deps.host.currentFence(sessionId)
    if (fence === null) {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    const body: AgentJournalMessageItem = {
      kind: 'message',
      role: 'user',
      blocks: [{ type: 'text', text: formatMessagePointer(unread.length, mailboxHandle).trim() }]
    }
    const staged = unread.map((message) => message.id)
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      body,
      messageIds: staged
    })
    const outcome = await this.deps.host.send({
      sessionId,
      dispatchId: target.dispatchId,
      operationId: operation.operationId,
      payloadFingerprint: operation.payloadFingerprint,
      expectedRuntimeFence: fence,
      body
    })
    if (outcome.kind === 'unattached') {
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    if (!structuredDispatchDelivered(outcome.state)) {
      this.retain(
        mailboxHandle,
        sessionId,
        retainReasonForDispatch(outcome.state as Exclude<StructuredDispatchState, 'accepted'>),
        reservedTypes
      )
      return
    }
    db.markAsDelivered(staged)
    // The nudge landed as its own turn, so the next settle edge is the natural retry point for
    // anything that arrives while it runs.
    db.deleteStructuredPointerOperation(mailboxHandle)
  }

  /** No `markAsUndelivered` is owed: rows are marked delivered only after an accepted dispatch. */
  private retain(
    mailboxHandle: string,
    sessionId: string,
    reason: StructuredPointerRetainReason,
    reservedTypes: ReadonlySet<string> | undefined
  ): void {
    this.deps.onRetain?.({ mailboxHandle, sessionId, reason })
    if (retainWaitsForJournalEdge(reason)) {
      this.parkedUntilJournalEdge.set(mailboxHandle, { sessionId, reservedTypes })
    }
  }
}
