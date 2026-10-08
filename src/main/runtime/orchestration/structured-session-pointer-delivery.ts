/**
 * What orchestration mail delivery reads of a host-owned structured ("native") agent session.
 *
 * A structured session has no PTY the pointer can be typed into, so the nudge travels as a session
 * turn instead of as bytes, and a busy session's own queue holds it until the turn ends.
 * Everything here is pure. Orchestration's database stays the source of truth: nothing here
 * consumes mail.
 */

import type { AgentJournalRenderItem } from '../../../shared/agent-session-journal-types'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredAgentSessionStatus
} from '../../../shared/structured-agent-session-projection'

/** Every reason retains the pointer; none of them consume mail. */
export type StructuredPointerRetainReason =
  | 'session-not-attached'
  | 'turn-unsettled'
  | 'dispatch-rejected'
  | 'dispatch-unknown'
  /** A steer waits out an approval or question, as the person's own Steer does. */
  | 'awaiting-human'

/** The dispatch states both provider adapters converge on. */
export type StructuredDispatchState = 'accepted' | 'rejected' | 'unknown'

/**
 * Whether a session is busy, in the vocabulary group addressing (`@idle`) matches on.
 *
 * Deliberately two booleans rather than the journal: the caller reads the FULL reduced timeline
 * (see `readStructuredSessionGateFacts`), so nothing downstream can be tempted to re-derive them
 * from a page.
 */
export type StructuredSessionGateFacts = {
  turnRunning: boolean
  /** A pending approval or question only a human can clear. */
  awaitingHuman: boolean
}

/**
 * Projects the gate facts off a session's live items.
 *
 * Reuses the projection the chat view already reads, so `@idle` and the visible
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
 * Only an accepted dispatch may mark mail delivered.
 *
 * `unknown` covers a dead provider child and a slow acknowledgement alike — the
 * adapters cannot tell them apart — so it must retain. Treating it as delivered
 * would drop mail whenever a child died mid-send.
 */
export function structuredDispatchDelivered(state: StructuredDispatchState): state is 'accepted' {
  return state === 'accepted'
}

export function retainReasonForDispatch(
  state: Exclude<StructuredDispatchState, 'accepted'>
): StructuredPointerRetainReason {
  return state === 'rejected' ? 'dispatch-rejected' : 'dispatch-unknown'
}
