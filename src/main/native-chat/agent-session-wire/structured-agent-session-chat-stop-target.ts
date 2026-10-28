// Capture once at acceptance; afterward only child identity can exclude the accepted target.

import { isQueuedAgentJournalSubmission } from '../../../shared/agent-session-queued-submission'
import type { StructuredAgentSessionProviderChild } from './structured-agent-session-host-types'
import { stopReachesUnrecordedWork } from './structured-agent-session-queued-stop'
import { isMainAgentWorking } from './structured-agent-session-turns-cancel'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'
import { structuredAgentSessionStoppedTurnId } from './structured-agent-session-turn-stop-notes'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import type { AgentJournalTurnScope } from '../../../shared/agent-session-journal-types'

/** close joins shutdown; starting ends startup; interrupt reaches live work; withdraw only settles queued sends. */
export type ChatStopReach = 'close' | 'starting' | 'interrupt' | 'withdraw'

export type ChatStopTarget = {
  reach: ChatStopReach
  child: StructuredAgentSessionProviderChild | null
  turnId: string | null
  turnScope: AgentJournalTurnScope
  named: boolean
  /** Named turn unless ending the provider session; then use the turn live at event write. */
  eventTurnId: string | null
  /** The held lane preserves the captured set of queued sends. */
  queued: boolean
  /** False reuses an existing Stop or only joins close. */
  marks: boolean
}

/** Late/empty Stops are accepted no-ops and must not withdraw or interrupt newer work. */
export function captureChatStopTarget(
  ctx: AgentSessionTurnContext,
  input: {
    child: StructuredAgentSessionProviderChild | null
    turnId?: string
    endsSession: boolean
    stoppedPrePrompt?: boolean
    stoppedSend?: boolean
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
    turnId: structuredAgentSessionStoppedTurnId(
      contextStructuredAgentSessionCurrentWork(ctx),
      turnId
    ),
    named: turnId !== undefined,
    turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope(),
    eventTurnId: input.endsSession ? null : (turnId ?? null),
    queued
  }
  if (child?.close) {
    return { ...target, reach: 'close', marks: queued }
  }
  if (child?.phase === 'starting') {
    return { ...target, reach: 'starting', marks: true }
  }
  // An aborted send remains this Stop's work even after its rejected answer reaches the fold.
  const canHaveGoal =
    ctx.agent !== undefined && ctx.agents.capabilities(ctx.agent)?.threadGoal === true
  if (
    !child ||
    (turnId === undefined && !input.stoppedSend && !isMainAgentWorking(ctx) && !canHaveGoal)
  ) {
    return queued || input.stoppedPrePrompt ? { ...target, reach: 'withdraw', marks: true } : null
  }
  // Repeated Stop must not pause cards queued after the first press.
  return { ...target, reach: 'interrupt', marks: queued || reached === 'unrecorded' }
}
