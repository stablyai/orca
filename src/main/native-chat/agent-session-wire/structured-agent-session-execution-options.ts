import {
  readAgentSessionExecutionOptions,
  type AgentSessionExecutionOptions
} from '../../../shared/agent-session-execution-options'
import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-options-read'

/** Capture once, while acceptance holds the conversation's ordered lane: the one read of a send's
 *  `options` record into the choices its message keeps, else the chat's saved ones. */
export function captureStructuredExecutionOptions(
  ctx: Pick<AgentSessionTurnContext, 'agents' | 'agent' | 'persistedOptions'>,
  supplied?: Readonly<Record<string, string>>
): { options: AgentSessionExecutionOptions } | { refusal: AgentSessionWireRefusal } {
  const saved = ctx.persistedOptions ?? {}
  const candidate = {
    ...(saved.model ? { model: saved.model } : {}),
    ...(saved.effort ? { effort: saved.effort } : {}),
    ...(saved.personality ? { personality: saved.personality } : {}),
    ...(saved.fastMode ? { fastMode: saved.fastMode } : {}),
    ...(saved.serviceTier ? { serviceTier: saved.serviceTier } : {}),
    ...supplied
  }
  const options = readAgentSessionExecutionOptions(candidate)
  if (!options) {
    return {
      refusal: refuse(
        'agent_session_operation_invalid',
        { reason: 'optionRejected' },
        'This message has an invalid choice.'
      )
    }
  }
  const refusal = structuredAgentSessionOptionOverridesRefusal(
    ctx.agents,
    ctx.agent,
    Object.fromEntries(
      Object.entries(options).filter(([key]) => !(ctx.agent === 'codex' && key === 'fastMode'))
    )
  )
  return refusal ? { refusal } : { options }
}
