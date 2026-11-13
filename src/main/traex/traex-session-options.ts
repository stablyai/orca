import type { AgentSessionOptionsResult } from '../../shared/agent-session/options/agent-session-options-result'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import type { TraexSession } from './traex-session'
import { isAgentSessionInteractionMode } from '../../shared/agent-session/options/agent-session-interaction-mode'

export function readTraexSessionOptions(session: TraexSession): AgentSessionOptionsResult {
  const selected = session.nativeModels.find(
    (model) => model.id === session.options.model || model.model === session.options.model
  )
  return {
    models: session.models,
    ...(session.models.length
      ? { listedModelIds: session.models.map((model) => model.id) }
      : { modelsKnown: false as const }),
    current: {
      model: session.options.model,
      effort: session.options.effort,
      reportedPermissionMode: session.reportedPermissionMode,
      reportedModel: session.reportedModel,
      ...(session.interactionModeSupported
        ? {
            interactionMode:
              session.options.interactionMode === 'plan' ? ('plan' as const) : ('default' as const)
          }
        : {})
    },
    acceptsImages: selected?.inputModalities ? selected.inputModalities.includes('image') : true,
    forkSupport: 'supported'
  }
}

export async function selectTraexSessionOption(
  session: TraexSession,
  key: string,
  value: string,
  signal?: AbortSignal
): Promise<void> {
  if (key === 'interactionMode') {
    if (!session.interactionModeSupported || !isAgentSessionInteractionMode(value)) {
      throw new AgentSessionOptionRejectedError('TRAE CLI did not offer this mode')
    }
    signal?.throwIfAborted()
    session.options[key] = value
    return
  }
  if (key !== 'model' && key !== 'effort') {
    throw new AgentSessionOptionRejectedError('TRAE CLI does not support this option')
  }
  const model = session.nativeModels.find(
    (entry) => entry.id === (key === 'model' ? value : session.options.model)
  )
  if (
    !model ||
    (key === 'effort' &&
      !model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === value))
  ) {
    throw new AgentSessionOptionRejectedError('TRAE CLI did not offer this model or effort')
  }
  signal?.throwIfAborted()
  // Model/effort are per-turn inputs; picking while a turn runs must not mutate that turn.
  session.options[key] = value
}
