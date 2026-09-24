// `agentSession.threadGoal`: change the provider thread's goal through the same
// admission, ledger and journal path every other session mutation takes.

import type {
  AgentJournalItemIdentity,
  AgentJournalThreadGoal
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session-wire'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

function refused(message: string): TurnOutcome<AgentSessionThreadGoalResult> {
  return { ok: false, refusal: { code: 'agent_session_operation_invalid', message } }
}

/** Keyed by the operation, so a replayed set upserts its one objective row. */
function objectiveIdentity(clientOperationId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `thread-goal:${clientOperationId}` }
}

/** Whether the journal's latest goal already shows this change applied. The
 *  provider reports every goal transition, so this is the durable answer to an
 *  operation whose response was lost. */
export function journalRecordsThreadGoalChange(
  goal: AgentJournalThreadGoal | null,
  change: AgentSessionThreadGoalChange
): boolean {
  switch (change.kind) {
    case 'clear':
      return goal === null
    case 'status':
      return goal !== null && goal.status === change.status
    case 'set':
      return goal !== null && goal.status === 'active' && goal.objective === change.objective
  }
}

export async function performThreadGoalChange(
  ctx: AgentSessionTurnContext,
  input: { clientOperationId: string; change: AgentSessionThreadGoalChange }
): Promise<TurnOutcome<AgentSessionThreadGoalResult>> {
  if (!ctx.adapter.changeThreadGoal || !ctx.adapter.supportsThreadGoal?.(ctx.sessionId)) {
    return refused('Goals are unavailable for this chat session.')
  }
  const { change } = input
  const identity = objectiveIdentity(input.clientOperationId)
  let replacesGoal = false
  if (change.kind === 'set') {
    // A goal transition the host accepted but has not journaled yet decides this too.
    await ctx.flushStreamedEvents()
    // Read before the objective row lands: that row is a message, not a goal transition.
    replacesGoal = ctx.journal.threadGoal() !== null
  }
  // Journal first: an active goal starts provider work at once, and the objective
  // must land ahead of that work in the transcript.
  if (change.kind === 'set') {
    await ctx.journal.appendItem(
      identity,
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: change.objective }],
        sentAs: 'goal'
      },
      { fence: ctx.fence }
    )
    ctx.publish()
  }
  const withdrawObjective = async (): Promise<void> => {
    if (change.kind === 'set') {
      // Nothing was sent as a goal.
      await ctx.journal.appendTombstone(identity, { fence: ctx.fence })
      ctx.publish()
    }
  }
  let result: Awaited<ReturnType<typeof ctx.adapter.changeThreadGoal>>
  try {
    result = await ctx.adapter.changeThreadGoal({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      change,
      replacesGoal
    })
  } catch (error) {
    await withdrawObjective()
    throw error
  }
  if (!result.ok) {
    await withdrawObjective()
    return refused(result.rejected)
  }
  return { ok: true, value: { change: change.kind } }
}

export function threadGoalPlan(params: {
  envelope: AgentSessionMutationEnvelope
  change: AgentSessionThreadGoalChange
}): MutationPlan<AgentSessionThreadGoalResult> {
  const value: AgentSessionThreadGoalResult = { change: params.change.kind }
  return {
    method: 'agentSession.threadGoal',
    fields: { change: params.change },
    run: (ctx) =>
      performThreadGoalChange(ctx, {
        clientOperationId: params.envelope.clientOperationId,
        change: params.change
      }),
    // A lost response is answered from the journal, which the provider keeps
    // current; otherwise the change runs again, which is safe for every kind.
    recoverUnknownFromDurableState: true,
    replay: (ctx, outcome) =>
      outcome.status === 'succeeded' ||
      (outcome.status === 'unknown' &&
        journalRecordsThreadGoalChange(ctx.journal.threadGoal(), params.change))
        ? value
        : null,
    rerunWhenReplayMissing: () => true
  }
}
