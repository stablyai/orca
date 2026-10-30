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
import {
  agentSessionAttachmentExpiredRefusal,
  type AgentSessionTurnContext,
  type TurnOutcome
} from './structured-agent-session-turns'
import { isAgentSessionAttachmentExpiredError } from '../agent-session-attachments/agent-session-attachment-claims'
import { captureStructuredExecutionOptions } from './structured-agent-session-execution-options'
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
  const captured =
    change.kind === 'set' || (change.kind === 'status' && change.status === 'active')
      ? captureStructuredExecutionOptions({
          ...ctx,
          persistedOptions: Object.fromEntries(
            Object.entries(ctx.persistedOptions ?? {}).filter(
              ([key]) => key === 'model' || key === 'effort'
            )
          )
        })
      : { options: undefined }
  if ('refusal' in captured) {
    return { ok: false, refusal: captured.refusal }
  }
  const identity = objectiveIdentity(input.clientOperationId)
  let replacesGoal = false
  if (change.kind === 'set') {
    // Read before the objective message lands; it is not a goal transition.
    replacesGoal = ctx.journal.threadGoal() !== null
  }
  try {
    // Journal first: active goals start work immediately, which must follow the objective in the transcript.
    throwIfSignalAborted(input.signal)
    if (change.kind === 'set') {
      try {
        // An objective naming a pasted file keeps it for the chat, as a sent message does.
        await ctx.journal.appendClaimingAttachments(
          identity,
          {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: change.objective }],
            sentAs: 'goal'
          },
          { fence: ctx.fence, turnScope: contextStructuredAgentSessionCurrentWork(ctx).turnScope() }
        )
      } catch (error) {
        if (isAgentSessionAttachmentExpiredError(error)) {
          return agentSessionAttachmentExpiredRefusal()
        }
        throw error
      }
    }
    const withdrawObjective = async (): Promise<void> => {
      if (change.kind === 'set') {
        await ctx.journal.withdrawGoalObjective(identity, { fence: ctx.fence })
      }
    }
    try {
      throwIfSignalAborted(input.signal)
    } catch (error) {
      await withdrawObjective()
      throw error
    }
    // A lost response cannot prove non-application; retain the objective for provider reconciliation.
    const result = await ctx.adapter.changeThreadGoal({
      sessionId: ctx.sessionId,
      fence: ctx.fence,
      change,
      replacesGoal,
      executionOptions: captured.options,
      signal: input.signal
    })
    if (!result.ok) {
      await withdrawObjective()
      return refused('providerRejected', result.rejected)
    }
    return { ok: true, value: { change: change.kind } }
  } finally {
    if (change.kind === 'set') {
      // Unknown application retains protection; a closed handle has already lost its delete permission.
      await ctx.journal.keepGoalAttachments(identity).catch(() => {})
    }
  }
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
    // Current state cannot identify an old operation after a later user action changed the goal.
    replay: (_ctx, outcome) => (outcome.status === 'succeeded' ? value : null)
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
