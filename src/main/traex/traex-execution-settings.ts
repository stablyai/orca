import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import type { TraexSession } from './traex-session'
import { traexRecord } from './traex-protocol'
import { effectiveAgentContextMode } from '../../shared/agent-session/options/model-catalog/agent-session-context-mode'

export function traexContextMode(
  session: TraexSession,
  options: { model?: string; contextMode?: string }
) {
  const model = options.model ?? session.options.model
  const selected = session.nativeModels.find((entry) =>
    model ? entry.id === model || entry.model === model : entry.isDefault
  )
  const variants = selected?.businessMetadata?.variants
  return effectiveAgentContextMode(
    options.contextMode ?? session.reportedContextMode,
    variants ? Boolean(variants.max_key) : undefined
  )
}

export function traexNativeExecutionSettings(
  session: TraexSession,
  options: { model?: string; effort?: string; interactionMode?: string; contextMode?: string }
) {
  const requestedModel = options.model ?? session.options.model
  const selected = session.nativeModels.find((model) =>
    requestedModel
      ? model.id === requestedModel || model.model === requestedModel
      : options.interactionMode && model.isDefault
  )
  if (requestedModel && session.nativeModels.length && !selected) {
    throw new AgentSessionOptionRejectedError('TRAE CLI did not offer this model')
  }
  if (options.interactionMode && !session.interactionModeSupported) {
    throw new AgentSessionOptionRejectedError('TRAE CLI modes have not been negotiated')
  }
  const model = selected?.model ?? requestedModel
  if (options.interactionMode && !model) {
    throw new AgentSessionOptionRejectedError('TRAE CLI did not resolve a model for this mode')
  }
  const contextMode = traexContextMode(session, options)
  return {
    ...(model ? { model } : {}),
    ...(selected?.modelProviderId ? { modelProvider: selected.modelProviderId } : {}),
    ...(contextMode ? { modelBackendVariant: contextMode === 'max' ? 'max' : null } : {}),
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.interactionMode && model
      ? {
          collaborationMode: {
            mode: options.interactionMode,
            settings: {
              model,
              reasoning_effort: options.effort ?? null,
              developer_instructions: null
            }
          }
        }
      : {})
  }
}

export async function installTraexExecutionSettings(
  session: TraexSession,
  options: { model?: string; effort?: string; interactionMode?: string; contextMode?: string },
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  const settings = traexNativeExecutionSettings(session, options)
  const response = await session.connection.request('thread/settings/update', {
    threadId: session.threadId!,
    ...settings
  })
  const applied = traexRecord(traexRecord(response).threadSettings)
  if (
    (settings.model && applied.model !== settings.model) ||
    (settings.effort && applied.effort !== settings.effort) ||
    ('modelBackendVariant' in settings &&
      applied.modelBackendVariant !== settings.modelBackendVariant) ||
    (settings.collaborationMode &&
      traexRecord(applied.collaborationMode).mode !== settings.collaborationMode.mode)
  ) {
    throw new Error('TRAE CLI did not confirm the requested execution settings')
  }
  signal?.throwIfAborted()
  const contextMode = traexContextMode(session, options)
  session.ranOptions = { ...session.options, ...options, ...(contextMode ? { contextMode } : {}) }
}
