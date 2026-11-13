import { AgentSessionOptionRejectedError } from '../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import type { TraexSession } from './traex-session'
import { traexRecord } from './traex-protocol'

export function traexNativeExecutionSettings(
  session: TraexSession,
  options: { model?: string; effort?: string; interactionMode?: string }
) {
  const selected = session.nativeModels.find(
    (model) => model.id === options.model || model.model === options.model
  )
  if (options.model && session.nativeModels.length && !selected) {
    throw new AgentSessionOptionRejectedError('TRAE CLI did not offer this model')
  }
  if (options.interactionMode && !session.interactionModeSupported) {
    throw new AgentSessionOptionRejectedError('TRAE CLI modes have not been negotiated')
  }
  const model = selected?.model ?? options.model
  return {
    ...(model ? { model } : {}),
    ...(selected?.modelProviderId ? { modelProvider: selected.modelProviderId } : {}),
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
  options: { model?: string; effort?: string; interactionMode?: string },
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
    (settings.collaborationMode &&
      traexRecord(applied.collaborationMode).mode !== settings.collaborationMode.mode)
  ) {
    throw new Error('TRAE CLI did not confirm the requested execution settings')
  }
  signal?.throwIfAborted()
  session.ranOptions = { ...session.options, ...options }
}
