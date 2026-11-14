import type {
  AgentSessionMutationEnvelope,
  AgentSessionMutationResult,
  AgentSessionOptionResult
} from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionMutationContext } from './structured-agent-session-mutation-context'
import { mutateStructuredAgentSession } from './structured-agent-session-mutation-context'
import type { StructuredAgentSessionCaller } from '../host/structured-agent-session-host-types'
import { setOptionPlan } from './structured-agent-session-mutation-plans'
import { openForWrite } from './structured-agent-session-send-preparation'
import { recordStructuredAgentSessionOptionIntent } from '../options/structured-agent-session-option-intent'
import { confirmIdleStructuredAgentSessionOption } from '../options/structured-agent-session-idle-option'

export async function setStructuredAgentSessionOption(
  context: StructuredAgentSessionMutationContext,
  caller: StructuredAgentSessionCaller,
  params: { envelope: AgentSessionMutationEnvelope; key: string; value: string }
): Promise<AgentSessionMutationResult<AgentSessionOptionResult>> {
  const plan = setOptionPlan(params)
  const noChoice =
    caller.readsOptionsWithoutModel === false && params.key === 'model' && params.value === ''
  return mutateStructuredAgentSession(
    context,
    caller,
    params.envelope,
    {
      ...plan,
      conversationWrite: true,
      run: async (ctx) => {
        const picked = await recordStructuredAgentSessionOptionIntent(context.deps, ctx, params, {
          readsWithoutModel: caller.readsOptionsWithoutModel !== false
        })
        if (picked.ok) {
          confirmIdleStructuredAgentSessionOption(context, ctx, params)
        }
        return picked
      },
      ...(noChoice
        ? {
            settledOutcome: (value: AgentSessionOptionResult) => ({
              status: 'succeeded' as const,
              sessionId: params.envelope.sessionId,
              optionResult: { version: 1, ...value }
            })
          }
        : {})
    },
    openForWrite(context, params.envelope)
  )
}
