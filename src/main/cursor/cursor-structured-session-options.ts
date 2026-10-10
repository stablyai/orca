import type { AgentSessionOptionsResult } from '../../shared/agent-session-wire'
import {
  cursorModelsToSessionOptions,
  cursorSelectedContextWindowTokens,
  type CursorModelListCache
} from './cursor-model-catalog'
import type { CursorLiveSession } from './cursor-structured-session-live'

export async function readCursorSessionOptions(input: {
  session: CursorLiveSession | undefined
  modelList: CursorModelListCache
  refresh: () => Promise<void>
}): Promise<AgentSessionOptionsResult> {
  const options = input.session?.options ?? {}
  await input.refresh()
  const listed = input.modelList.models
  const models = cursorModelsToSessionOptions(listed)
  const model = options.model || models.find((entry) => entry.isDefault)?.id || 'auto'
  input.session?.translator.setContextWindowTokens(
    cursorSelectedContextWindowTokens({ ...options, model }, listed)
  )
  return {
    models,
    ...(models.some((entry) => entry.supportsFastMode)
      ? { fastModeSupport: { supported: true as const } }
      : {}),
    current: {
      model,
      ...(options.effort ? { effort: options.effort } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.thinking ? { thinking: options.thinking } : {}),
      ...(options.fastMode === 'true' || options.fastMode === 'false'
        ? { fastMode: options.fastMode === 'true' }
        : {}),
      ...(input.session?.mode ? { conversationMode: input.session.mode } : {}),
      confirmed: [
        'model',
        ...(options.effort ? ['effort'] : []),
        ...(options.context ? ['context'] : []),
        ...(options.thinking ? ['thinking'] : []),
        'conversationMode'
      ]
    }
  }
}
