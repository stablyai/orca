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
 * session whose turn ends — so nothing else would ever prompt it for its own `run:` mail.
 *
 * A chat assignee's owed dispatch preamble (`dispatch_preamble_turns`) is not mail: it is the turn a
 * PTY assignee would have typed into its pane. Its Dispatch mailbox sends it first, alone and as its
 * own body, under the same operation-id rules as mail, but with the id kept on its own row: a retry
 * or replay reuses it and starts nothing, it dies with the row, and no mail batch or mail reset can
 * touch it. Mail waits behind it.
 */

import type { AgentJournalMessageItem } from '../../../shared/agent-session-journal-types'
import type { OrchestrationDb } from './db'
import { formatMessagePointer } from './formatter'
import type { OrchestrationCliCommand } from './cli-command'
import {
  selectOrchestrationPointerBatch,
  type OrchestrationMessageWaiter
} from './mailbox-pointer-eligibility'
import {
  resolveStructuredPointerOperation,
  type StructuredPointerLedger,
  type StructuredPointerSubmission
} from './structured-pointer-operation-id'
import {
  decideStructuredSessionPointerDelivery,
  retainReasonForDispatch,
  structuredDispatchDelivered,
  type StructuredDispatchState,
  type StructuredPointerRetainReason,
  type StructuredSessionGateFacts
} from './structured-session-pointer-delivery'

export type StructuredPointerTarget = {
  sessionId: string
  /**
   * The dispatch whose mailbox this is, or null for direct peer mail addressed to the worker's own
   * handle outside any dispatch. Nothing downstream needs a dispatch to deliver — it only scopes
   * the operation-ledger budget — so a worker between dispatches is nudged, not dropped.
   */
  dispatchId: string | null
}

/** One send the lane makes, and what its outcome means for what it stands for. */
type StructuredPointerPayload = {
  text: string
  /** What the send stands for; batch identity, not the body, decides operation-id reuse. */
  batchIds: readonly string[]
  /** Right before the send: false when what it stands for may no longer be sent. */
  claim: () => boolean
  settle: (outcome: 'delivered' | 'not-delivered' | 'in-doubt') => void
  /** Where its operation id lives; absent for mail, whose id is the mailbox's ledger row. */
  ledger?: StructuredPointerLedger
}

type ParkedPointerDelivery = {
  sessionId: string
  reservedTypes: ReadonlySet<string> | undefined
}

export type StructuredPointerSendOutcome =
  | { kind: 'sent'; state: StructuredDispatchState }
  | { kind: 'unattached' }

export type StructuredPointerGateFacts = StructuredSessionGateFacts & {
  /** Every send the session recorded, oldest first: what the lane's own sends settled as. */
  submissions: readonly StructuredPointerSubmission[]
}

export type StructuredMailboxPointerHost = {
  /** The idle gate, read off the session's full reduced timeline; `null` when it cannot be read. */
  readGateFacts: (sessionId: string) => Promise<StructuredPointerGateFacts | null>
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
   * The mailbox is a `dispatch:` address or the worker's own bearer handle; the second is how
   * agents mail each other outside a dispatch, and no other lane can serve it.
   */
  resolveStructuredTarget: (mailboxHandle: string) => StructuredPointerTarget | null
  /** The CLI name the PTY lane types for a local agent, so both lanes send the same pointer. */
  getCliCommand: () => OrchestrationCliCommand
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
    reservedTypes?: ReadonlySet<string>
  ): Promise<void> {
    const db = this.deps.getDb()
    if (!db || this.inFlight.has(mailboxHandle)) {
      return
    }
    const preamble = target.dispatchId ? db.getDispatchPreambleTurn?.(target.dispatchId) : undefined
    if (target.dispatchId && preamble && preamble.state !== 'delivered') {
      await this.attemptOnce(db, mailboxHandle, target, reservedTypes, {
        text: preamble.body,
        batchIds: [`dispatch_preamble:${target.dispatchId}`],
        ledger: {
          stored: preamble.operation_id
            ? {
                mailbox_handle: mailboxHandle,
                session_id: preamble.session_id ?? '',
                operation_id: preamble.operation_id,
                batch_fingerprint: preamble.batch_fingerprint ?? '',
                minted_at_ms: preamble.minted_at_ms ?? 0
              }
            : undefined,
          put: (row) => db.recordDispatchPreambleTurnOperation(preamble.dispatch_id, row)
        },
        claim: () => db.claimDispatchPreambleTurnSend(preamble.dispatch_id),
        settle: (outcome) =>
          db.settleDispatchPreambleTurnSend(
            preamble.dispatch_id,
            outcome === 'delivered' ? 'delivered' : outcome === 'in-doubt' ? 'in_doubt' : 'owed'
          )
      })
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
    const staged = unread.map((message) => message.id)
    await this.attemptOnce(db, mailboxHandle, target, reservedTypes, {
      text: formatMessagePointer(unread.length, mailboxHandle, this.deps.getCliCommand()).trim(),
      batchIds: staged,
      claim: () => true,
      settle: (outcome) => {
        if (outcome === 'delivered') {
          db.markAsDelivered(staged)
        }
      }
    })
  }

  private async attemptOnce(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    reservedTypes: ReadonlySet<string> | undefined,
    payload: StructuredPointerPayload
  ): Promise<void> {
    this.inFlight.add(mailboxHandle)
    try {
      await this.attempt(db, mailboxHandle, target, payload, reservedTypes)
    } finally {
      this.inFlight.delete(mailboxHandle)
    }
  }

  // A session whose agent is not running needs nothing first: an accepted send starts it.
  private async attempt(
    db: OrchestrationDb,
    mailboxHandle: string,
    target: StructuredPointerTarget,
    payload: StructuredPointerPayload,
    reservedTypes: ReadonlySet<string> | undefined
  ): Promise<void> {
    const sessionId = target.sessionId
    const session = await this.deps.host.readGateFacts(sessionId)
    const decision = decideStructuredSessionPointerDelivery({ session })
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
      blocks: [{ type: 'text', text: payload.text }]
    }
    const operation = resolveStructuredPointerOperation({
      db,
      mailboxHandle,
      sessionId,
      body,
      messageIds: payload.batchIds,
      submissions: session?.submissions ?? [],
      sentByThisProcess: this.sentOperationIds.get(mailboxHandle),
      ...(payload.ledger ? { ledger: payload.ledger } : {})
    })
    if (operation.kind === 'stamp') {
      // A send this lane gave up waiting on ran after all.
      payload.settle('delivered')
      this.dropMailOperation(db, mailboxHandle, payload)
      this.sentOperationIds.delete(mailboxHandle)
      return
    }
    if (operation.kind === 'park') {
      payload.settle('in-doubt')
      this.retain(mailboxHandle, sessionId, 'turn-unsettled', reservedTypes)
      return
    }
    if (!payload.claim()) {
      return
    }
    this.sentOperationIds.set(mailboxHandle, operation.operationId)
    const outcome = await this.deps.host
      .send({
        sessionId,
        dispatchId: target.dispatchId,
        operationId: operation.operationId,
        payloadFingerprint: operation.payloadFingerprint,
        expectedRuntimeFence: fence,
        body
      })
      .catch((error: unknown) => {
        payload.settle('in-doubt')
        throw error
      })
    if (outcome.kind === 'unattached') {
      payload.settle('not-delivered')
      this.retain(mailboxHandle, sessionId, 'session-not-attached', reservedTypes)
      return
    }
    if (!structuredDispatchDelivered(outcome.state)) {
      payload.settle(outcome.state === 'rejected' ? 'not-delivered' : 'in-doubt')
      // The row stays: resending under its id replays this verdict and starts nothing.
      this.retain(mailboxHandle, sessionId, retainReasonForDispatch(outcome.state), reservedTypes)
      return
    }
    payload.settle('delivered')
    // The nudge landed as its own turn, so the next settle edge is the natural retry point for
    // anything that arrives while it runs.
    this.dropMailOperation(db, mailboxHandle, payload)
    this.sentOperationIds.delete(mailboxHandle)
  }

  /** A delivered mail send's ledger row goes; a preamble's id stays on its own, delivered row. */
  private dropMailOperation(
    db: OrchestrationDb,
    mailboxHandle: string,
    payload: StructuredPointerPayload
  ): void {
    if (!payload.ledger) {
      db.deleteStructuredPointerOperation(mailboxHandle)
    }
  }

  /**
   * No `markAsUndelivered` is owed: rows are marked delivered only after an accepted dispatch.
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
