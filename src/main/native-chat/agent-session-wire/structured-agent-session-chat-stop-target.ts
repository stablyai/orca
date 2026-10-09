// What the chat's Stop acts on, decided ONCE, on the session's lane, as it is accepted: the turn
// it is about, the provider child it reaches, and whether it holds what is queued. After the
// acceptance commits, the Stop acts only while that target still stands, read again from state,
// so a newer turn or a newer child is never this Stop's.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { stopReachesUnrecordedWork } from './structured-agent-session-queued-stop'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import { structuredAgentSessionStoppedTurnId } from './structured-agent-session-turn-stop-notes'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'

/**
 * - `close`: joins the close an earlier stop began on the child, which takes no input.
 * - `starting`: ends a start that may never land; it takes no interrupt.
 * - `interrupt`: interrupts what the child runs, ending it when the interrupt fails.
 * - `hold`: no agent to reach; it only holds what is queued.
 */
export type ChatStopReach = 'close' | 'starting' | 'interrupt' | 'hold'

export type ChatStopTarget = {
  reach: ChatStopReach
  child: StructuredAgentSessionProviderChild | null
  /** The turn the Stop is about: the one it named, else the one live as it was accepted. */
  turnId: string | null
  named: boolean
  /** The turn its event names: a Stop that ends the provider's session ends whatever runs. */
  eventTurnId: string | null
  /** It writes a Stop event of its own; else it repeats the one in force, or only joins a close. */
  marks: boolean
}

/** Null: a late Stop, or one with nothing queued and nothing in flight, which is an accepted
 *  no-op. A Stop naming a turn that already ended holds nothing and interrupts nothing. */
export function captureChatStopTarget(
  ctx: AgentSessionTurnContext,
  input: {
    child: StructuredAgentSessionProviderChild | null
    turnId?: string
    endsSession: boolean
  }
): ChatStopTarget | null {
  const { child, turnId } = input
  const reached = stopReachesUnrecordedWork(ctx, turnId)
  if (reached === 'late') {
    return null
  }
  const queued = ctx.journal.submissions().some(isQueuedAgentJournalSubmission)
  const target = {
    child,
    turnId: structuredAgentSessionStoppedTurnId(ctx.journal, turnId),
    named: turnId !== undefined,
    eventTurnId: structuredAgentSessionStoppedTurnId(
      ctx.journal,
      input.endsSession ? undefined : turnId
    )
  }
  if (child?.close) {
    return { ...target, reach: 'close', marks: queued }
  }
  if (child?.phase === 'starting') {
    return { ...target, reach: 'starting', marks: true }
  }
  // A Stop naming no turn ends nothing more unless the session reads working, by the rule every
  // session list and the chat's own Stop read it, over the fold as it stands.
  if (!child || (turnId === undefined && !isMainAgentWorking(ctx))) {
    return queued ? { ...target, reach: 'hold', marks: true } : null
  }
  // Repeating the Stop in force with nothing sent since writes no second event, so a card queued
  // between the presses sends normally, as after one Stop.
  return { ...target, reach: 'interrupt', marks: queued || reached === 'unrecorded' }
}

/** After the acceptance: whether the captured target still stands. A newer child, or a turn other
 *  than the captured one, is not this Stop's to interrupt. */
export function chatStopTargetStands(
  ctx: AgentSessionTurnContext,
  target: ChatStopTarget,
  currentChild: StructuredAgentSessionProviderChild | null | undefined
): boolean {
  if (currentChild !== target.child) {
    return false
  }
  if (target.reach !== 'interrupt') {
    return true
  }
  const live = ctx.journal.activeTurnId()
  if (target.named) {
    // As at acceptance: no turn published yet while the agent works, the named one may be opening.
    return live === target.turnId || (live === null && isMainAgentWorking(ctx))
  }
  return target.turnId === null ? isMainAgentWorking(ctx) : live === target.turnId
}
