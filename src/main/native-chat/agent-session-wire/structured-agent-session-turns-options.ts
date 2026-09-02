import type { AgentSessionOptionResult } from '../../../shared/agent-session-wire'
import { isAgentSessionOptionRejectedError } from './structured-agent-session-option-error'
import type { AgentSessionTurnContext, TurnOutcome } from './structured-agent-session-turns'

export async function performSetOption(
  ctx: AgentSessionTurnContext,
  input: { key: string; value: string }
): Promise<TurnOutcome<AgentSessionOptionResult>> {
  let applied: void | Readonly<Record<string, string>>
  try {
    applied = await ctx.adapter.setOption({
      sessionId: ctx.sessionId,
      ...input,
      fence: ctx.fence
    })
  } catch (error) {
    if (isAgentSessionOptionRejectedError(error)) {
      return {
        ok: false,
        refusal: { code: 'agent_session_operation_invalid', message: error.message }
      }
    }
    throw error
  }
  await ctx.persistOptions(applied ?? { [input.key]: input.value })
  return { ok: true, value: { ...input, ...(applied ? { options: { ...applied } } : {}) } }
}
