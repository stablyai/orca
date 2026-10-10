import { refuse, type AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function performSetOption(
  ctx: AgentSessionTurnContext,
  input: { key: string; value: string },
  signal?: AbortSignal
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  let applied: void | Readonly<Record<string, string>>
  try {
    applied = await ctx.adapter.setOption({
      sessionId: ctx.sessionId,
      ...input,
      fence: ctx.fence,
      ...(signal ? { signal } : {})
    })
  } catch (error) {
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        ok: false,
        refusal: refuse(
          'agent_session_operation_invalid',
          { reason: error.refusalReason },
          error.message
        )
      }
    }
    throw error
  }
  // Any model set here counts as a picker's, whoever calls this public RPC.
  await ctx.persistOptions(
    applied ?? { [input.key]: input.value },
    input.key === 'model' ? 'picker' : undefined
  )
  ctx.publish()
  return { ok: true, value: { ...input, ...(applied ? { options: { ...applied } } : {}) } }
}
