import {
  readAgentSessionExecutionOptions,
  type AgentSessionExecutionOptions
} from '../../../shared/agent-session-execution-options'
import { refuse, type AgentSessionWireRefusal } from '../../../shared/agent-session-wire'
import type { AgentSessionTurnContext } from './structured-agent-session-turns'
import { structuredAgentSessionOptionOverridesRefusal } from './structured-agent-session-options-read'

/** Capture send-specific choices or saved defaults once under the acceptance lane. */
export function captureStructuredExecutionOptions(
  ctx: Pick<AgentSessionTurnContext, 'agents' | 'agent' | 'persistedOptions'>,
  supplied?: Readonly<Record<string, string>>,
  selection?: Readonly<Record<string, string>>
): { options: AgentSessionExecutionOptions } | { refusal: AgentSessionWireRefusal } {
  const saved = ctx.persistedOptions ?? {}
  const candidate: Record<string, string> =
    selection === undefined
      ? { ...saved, ...supplied }
      : {
          ...(saved.personality ? { personality: saved.personality } : {}),
          ...selection
        }
  // A missing Fast pick has a definite baseline on hosts that offer it.
  if (
    candidate.fastMode === undefined &&
    ctx.agents.definition(ctx.agent)?.restingOptions.acceptsKey('fastMode')
  ) {
    candidate.fastMode = 'false'
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

/** The model and effort the chat was created with, which its opening message runs on as a send's
 *  carried ones do. */
export function openingMessageOptions(options: Readonly<Record<string, string>> | undefined): {
  options?: AgentSessionExecutionOptions
} {
  const { model, effort } = options ?? {}
  return model ? { options: { model, ...(effort ? { effort } : {}) } } : {}
}
