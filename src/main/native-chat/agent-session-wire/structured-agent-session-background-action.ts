import type {
  AgentSessionForegroundTask,
  AgentSessionBackgroundResult
} from '../../../shared/agent-session/agent-session-foreground-task'
import type { AgentSessionMutationEnvelope } from '../../../shared/agent-session/agent-session-wire'
import { refuseUnclassified } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import type { StructuredAgentSessionCaller } from './host/structured-agent-session-host-types'
import {
  mutateStructuredAgentSession,
  type StructuredAgentSessionMutationContext
} from './operations/structured-agent-session-mutation-context'
import { openForProviderWrite } from './operations/structured-agent-session-send-preparation'
import type { MutationPlan } from './operations/structured-agent-session-mutation-plans'

/** Replays report the recorded answer; they never detach a later invocation. */
export function backgroundStructuredAgentSessionTask(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; target: AgentSessionForegroundTask }
) {
  const value: AgentSessionBackgroundResult = { backgrounded: true }
  const plan: MutationPlan<AgentSessionBackgroundResult> = {
    method: 'agentSession.backgroundTask',
    fields: { target: params.target },
    run: async (ctx) => {
      const backgrounded = await ctx.adapter.backgroundTask?.({
        ...params.target,
        sessionId: ctx.sessionId,
        fence: ctx.fence
      })
      ctx.publish()
      return backgrounded
        ? { ok: true, value }
        : {
            ok: false,
            refusal: refuseUnclassified(
              'agent_session_operation_invalid',
              'This command is no longer running in the foreground. No task was moved.'
            )
          }
    },
    replay: (_ctx, outcome) => (outcome.status === 'succeeded' ? value : null)
  }
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    plan,
    openForProviderWrite(context, params.envelope)
  )
}
