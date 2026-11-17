import type { AgentSessionOptionsResult } from '../../shared/agent-session/options/protocol/agent-session-options-result'
import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import type { TraexSession } from './traex-session'
import { isAgentSessionInteractionMode } from '../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import type { StructuredAgentSessionAdapter } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter'
import { readAgentSessionExecutionOptions } from '../../shared/agent-session/options/protocol/agent-session-execution-options'
import { traexContextMode } from './traex-execution-settings'

export function captureTraexMessageSteeringInputs(
  session: TraexSession | undefined,
  input: Parameters<NonNullable<StructuredAgentSessionAdapter['captureMessageSteeringInputs']>>[0]
): ReturnType<NonNullable<StructuredAgentSessionAdapter['captureMessageSteeringInputs']>> {
  if (
    !session ||
    session.ended ||
    session.connection.closed ||
    !session.activeTurn ||
    session.input.fence !== input.fence ||
    session.generation !== input.acquisitionGeneration
  ) {
    return { kind: 'codex-unavailable' }
  }
  return {
    kind: 'trae',
    active: readAgentSessionExecutionOptions(session.ranOptions) ?? {},
    defaults:
      readAgentSessionExecutionOptions({
        ...session.options,
        contextMode: traexContextMode(session, session.options)
      }) ?? {},
    models: session.nativeModels.map(({ id, model, businessMetadata }) => ({
      id,
      model,
      ...(businessMetadata?.variants
        ? { supportsMaxMode: Boolean(businessMetadata.variants.max_key) }
        : {})
    }))
  }
}

export function readTraexSessionOptions(session: TraexSession): AgentSessionOptionsResult {
  const selected = session.nativeModels.find(
    (model) => model.id === session.options.model || model.model === session.options.model
  )
  const contextMode = traexContextMode(session, session.options)
  return {
    models: session.models,
    ...(session.models.length
      ? { listedModelIds: session.models.map((model) => model.id) }
      : { modelsKnown: false as const }),
    current: {
      model: session.options.model,
      effort: session.options.effort,
      ...(contextMode ? { contextMode } : {}),
      ...(contextMode && contextMode === session.reportedContextMode
        ? { confirmed: ['contextMode'] }
        : {}),
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
  if (key === 'contextMode') {
    const model = session.models.find((entry) => entry.id === session.options.model)
    if (model?.supportsMaxMode !== true || (value !== 'standard' && value !== 'max')) {
      throw new AgentSessionOptionRejectedError('TRAE CLI did not offer this context mode')
    }
    signal?.throwIfAborted()
    session.options.contextMode = value
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
