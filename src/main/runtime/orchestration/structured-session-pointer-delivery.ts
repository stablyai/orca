/**
 * Delivery decisions for an orchestration mail pointer aimed at a host-owned
 * structured ("native") agent session.
 *
 * A structured session has no PTY the pointer can be typed into, so the nudge
 * travels as a session turn instead of as bytes. Everything here is pure: the
 * caller supplies the refusal and the session's gate facts, and gets back a
 * decision it can act on. Orchestration's database stays the source of truth —
 * no decision here ever consumes mail, it only says whether the nudge may be
 * attempted now.
 */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import type { AgentSessionPtyWriteRefusal } from '../../../shared/agent-session-pty-write-admission'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'

/** Every reason retains the pointer; none of them consume mail. */
export type StructuredPointerRetainReason =
  | 'owner-not-settled-native'
  | 'session-not-attached'
  | 'turn-unsettled'
  | 'awaiting-human'
  | 'dispatch-rejected'
  | 'dispatch-unknown'

export type StructuredPointerDecision =
  | { deliver: true }
  | { deliver: false; retain: StructuredPointerRetainReason }

/** The dispatch states both provider adapters converge on. */
export type StructuredDispatchState = 'accepted' | 'rejected' | 'unknown'

/**
 * A refusal names an owner this pointer may be redirected to only when that
 * owner is native AND settled. A recovering or mid-handoff lease also reports
 * `native`, but it may become a TUI again, so redirecting there races the
 * takeover.
 */
export function isSettledNativeOwner(refusal: AgentSessionPtyWriteRefusal): boolean {
  return (
    refusal.ownerRuntimeKind === 'native' &&
    refusal.code === 'agent_session_conflict' &&
    refusal.handoffStage === null
  )
}

/**
 * What the delivery gate needs to know about a session, read once per attempt.
 *
 * Deliberately two booleans rather than the journal: the caller reads the FULL reduced timeline
 * (see `readGateFacts`), so nothing downstream can be tempted to re-derive them from a page.
 */
export type StructuredSessionGateFacts = {
  turnRunning: boolean
  /** A pending approval or question only a human can clear. */
  awaitingHuman: boolean
}

/**
 * Projects the gate facts off a session's live items.
 *
 * Reuses the projection the chat view already reads, so the delivery gate and the visible
 * "working" state can never disagree. Both must be answered from the fully reduced timeline: a
 * settled turn is TOMBSTONED rather than rewritten to `completed`, so on a bounded tail page an
 * idle session and a running turn whose lifecycle item was pushed off the end look identical —
 * and idle-with-history is the normal steady state of a working agent.
 */
export function structuredSessionGateFacts(
  items: readonly AgentJournalRenderItem[]
): StructuredSessionGateFacts {
  return {
    turnRunning: activeStructuredAgentSessionTurnId(items) !== null,
    awaitingHuman: projectStructuredAgentSessionStatus(items) === 'attention'
  }
}

/**
 * Decide whether the nudge may be sent right now.
 *
 * Mid-turn delivery is refused for both providers rather than delegated to
 * them: Codex answers a mid-turn `turn/start` with `turn already running`, and
 * Claude accepts the frame but cannot acknowledge it inside the dispatch ack
 * window, settling `unknown` while the message is really queued. Waiting for
 * the turn to settle is the one contract that holds for both, and it preserves
 * orchestration's existing idle-edge-only delivery policy.
 */
export function decideStructuredPointerDelivery(input: {
  refusal: AgentSessionPtyWriteRefusal
  /** Null when the session is not attached to this host. */
  session: StructuredSessionGateFacts | null
}): StructuredPointerDecision {
  if (!isSettledNativeOwner(input.refusal)) {
    return { deliver: false, retain: 'owner-not-settled-native' }
  }
  return decideStructuredSessionPointerDelivery(input)
}

/**
 * The same decision for a session that was BORN structured.
 *
 * There is no PTY write to be refused, so there is no refusal to read an owner off — the caller
 * already knows the session is host-owned because it created it. Everything after that gate is
 * identical, which is why the adopted-TUI path above delegates here rather than duplicating it.
 */
export function decideStructuredSessionPointerDelivery(input: {
  session: StructuredSessionGateFacts | null
}): StructuredPointerDecision {
  if (!input.session) {
    return { deliver: false, retain: 'session-not-attached' }
  }
  // Checked before the turn gate: a pending prompt has no running turn, so the turn test alone
  // reads it as idle, and sending there queues a nudge behind something only a human can clear.
  if (input.session.awaitingHuman) {
    return { deliver: false, retain: 'awaiting-human' }
  }
  if (input.session.turnRunning) {
    return { deliver: false, retain: 'turn-unsettled' }
  }
  return { deliver: true }
}

/**
 * Only an accepted dispatch may mark mail delivered.
 *
 * `unknown` covers a dead provider child and a slow acknowledgement alike — the
 * adapters cannot tell them apart — so it must retain. Treating it as delivered
 * would drop mail whenever a child died mid-send.
 */
export function structuredDispatchDelivered(state: StructuredDispatchState): boolean {
  return state === 'accepted'
}

export function retainReasonForDispatch(
  state: Exclude<StructuredDispatchState, 'accepted'>
): StructuredPointerRetainReason {
  return state === 'rejected' ? 'dispatch-rejected' : 'dispatch-unknown'
}

/**
 * Whether a retained pointer should be parked for the session's next journal edge, or is cheap
 * enough to re-attempt on any later trigger.
 *
 * `unknown` may mean the nudge is already sitting in the provider's input queue, so an immediate
 * retry can stack duplicate nudges that each become a turn later. `session-not-attached` parks for
 * the opposite reason: nothing else will ever notice the re-attach, and the dispatch preamble
 * tells workers not to poll, so an unparked pointer leaves the worker idle on unread mail.
 * `dispatch-rejected` parks for that same reason: a rejection consumes no mail and is usually a
 * stale fence or a lease that has since moved, both of which the next journal edge re-reads.
 *
 * Only `owner-not-settled-native` is excluded, and it is unreachable in practice: the resolver
 * refuses to name an unsettled owner, so the pointer falls through to the PTY lane before it can
 * be retained here. Phrased as an exclusion so a reason added later parks by default — parking
 * only adds a retry edge, while forgetting to park is how mail goes unnoticed.
 */
export function retainWaitsForJournalEdge(reason: StructuredPointerRetainReason): boolean {
  return reason !== 'owner-not-settled-native'
}
