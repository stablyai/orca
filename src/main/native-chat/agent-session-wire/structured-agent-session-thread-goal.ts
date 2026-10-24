import {
  refuse,
  type AgentSessionRefusalReason,
  type AgentSessionWireRefusal
} from '../../../shared/agent-session-wire-refusals'
import type {
  AgentJournalCursor,
  AgentJournalItemIdentity,
  AgentJournalThreadGoal
} from '../../../shared/agent-session-journal-types'
import type {
  AgentSessionMutationEnvelope,
  AgentSessionOptionsResult
} from '../../../shared/agent-session-wire'
import type {
  AgentSessionThreadGoalChange,
  AgentSessionThreadGoalResult
} from '../../../shared/agent-session-thread-goal-wire'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import type { StructuredAgentRegistry } from './structured-agent-registry'
import type { MutationPlan } from './structured-agent-session-mutation-plans'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'
import { throwIfSignalAborted } from '../../../shared/abort-signal-reason'
import { contextStructuredAgentSessionCurrentWork } from './structured-agent-session-current-work'

function refused(
  reason: AgentSessionRefusalReason<'agent_session_operation_invalid'>,
  message: string
): { ok: false; refusal: AgentSessionWireRefusal } {
  return { ok: false, refusal: refuse('agent_session_operation_invalid', { reason }, message) }
}

const goalsUnsupported = () =>
  refused('goalsUnsupported', 'Goals are unavailable for this chat session.')

export function refuseThreadGoalUnsupported(
  adapter: Pick<StructuredAgentSessionAdapter, 'changeThreadGoal'>,
  agents: Pick<StructuredAgentRegistry, 'capabilities'>,
  agent: string | undefined
): { ok: false; refusal: AgentSessionWireRefusal } | null {
  return adapter.changeThreadGoal && agent && agents.capabilities(agent)?.threadGoal
    ? null
    : goalsUnsupported()
}

/** Operation identity makes replay upsert the same objective row. */
function objectiveIdentity(clientOperationId: string): AgentJournalItemIdentity {
  return { provider: 'orca', clientMessageId: `thread-goal:${clientOperationId}` }
}

/** Provider-journaled transitions recover operations whose response was lost. */
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
  input: { clientOperationId: string; change: AgentSessionThreadGoalChange; signal?: AbortSignal }
): Promise<TurnOutcome<AgentSessionThreadGoalResult>> {
  if (
    !ctx.adapter.changeThreadGoal ||
    refuseThreadGoalUnsupported(ctx.adapter, ctx.agents, ctx.agent)
  ) {
    return goalsUnsupported()
  }
  const { change } = input
  const identity = objectiveIdentity(input.clientOperationId)
  let replacesGoal = false
  if (change.kind === 'set') {
    // Read before the objective message lands; it is not a goal transition.
    replacesGoal = ctx.journal.threadGoal() !== null
  }
  // Journal first: active goals start work immediately, which must follow the objective in the transcript.
  throwIfSignalAborted(input.signal)
  if (change.kind === 'set') {
    await ctx.journal.appendItem(
      identity,
      {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: change.objective }],
        sentAs: 'goal'
      },
      { fence: ctx.fence, turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope() }
    )
  }
  const withdrawObjective = async (): Promise<void> => {
    if (change.kind === 'set') {
      await ctx.journal.appendTombstone(identity, { fence: ctx.fence })
    }
  }
  let result: Awaited<ReturnType<typeof ctx.adapter.changeThreadGoal>>
  try {
    throwIfSignalAborted(input.signal)
    result = await ctx.adapter.changeThreadGoal({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      change,
      replacesGoal,
      signal: input.signal
    })
  } catch (error) {
    await withdrawObjective()
    throw error
  }
  if (!result.ok) {
    await withdrawObjective()
    return refused('providerRejected', result.rejected)
  }
  return { ok: true, value: { change: change.kind } }
}

export function threadGoalPlan(params: {
  envelope: AgentSessionMutationEnvelope
  change: AgentSessionThreadGoalChange
  signal?: AbortSignal
}): MutationPlan<AgentSessionThreadGoalResult> {
  const value: AgentSessionThreadGoalResult = { change: params.change.kind }
  return {
    method: 'agentSession.threadGoal',
    fields: { change: params.change },
    run: (ctx) =>
      performThreadGoalChange(ctx, {
        clientOperationId: params.envelope.clientOperationId,
        change: params.change,
        signal: params.signal
      }),
    // Recover lost responses from provider-journaled state; otherwise every change is safe to repeat.
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

/** Report host-changeable goals separately from goals only the agent’s /goal can change. */
export function structuredAgentSessionThreadGoalReport(
  hostChangesGoal: boolean,
  current: AgentJournalThreadGoal | null,
  contextFloor: { contextFloor?: AgentJournalCursor }
): Pick<AgentSessionOptionsResult, 'threadGoal' | 'reportedThreadGoal'> {
  if (hostChangesGoal) {
    return { threadGoal: { current, ...contextFloor } }
  }
  return current ? { reportedThreadGoal: { current, ...contextFloor } } : {}
}
