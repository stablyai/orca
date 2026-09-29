import { defineMethod, type RpcContext } from '../core'
import { SPEECH_OPENROUTER_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import type { RuntimeSpeechSetupState } from '../../../../shared/runtime-worktree-contracts'
import {
  DictationChunk,
  DictationHandle,
  DictationSetup,
  DictationStart,
  SpeechModelAction
} from '../../../../shared/rpc-contract/speech-params'

function supportsOpenRouter(context: RpcContext): boolean {
  return (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(SPEECH_OPENROUTER_RUNTIME_CAPABILITY) === true
  )
}

function projectSpeechSetup(
  setup: RuntimeSpeechSetupState,
  context: RpcContext
): RuntimeSpeechSetupState {
  if (supportsOpenRouter(context)) {
    return setup
  }
  // Older clients offer local download/delete actions for unknown providers.
  return { ...setup, models: setup.models.filter((model) => model.provider !== 'openrouter') }
}

export const SPEECH_METHODS = [
  defineMethod({
    name: 'speech.models.list',
    params: null,
    handler: async (_params, context) =>
      projectSpeechSetup(await context.runtime.listMobileSpeechModels(), context)
  }),
  defineMethod({
    name: 'speech.models.download',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.downloadMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.models.delete',
    params: SpeechModelAction,
    handler: async (params, context) =>
      projectSpeechSetup(await context.runtime.deleteMobileSpeechModel(params.modelId), context)
  }),
  defineMethod({
    name: 'speech.dictation.setup',
    params: DictationSetup,
    handler: async (params, context) =>
      projectSpeechSetup(
        await context.runtime.configureMobileDictation({
          ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
          ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
          ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {})
        }),
        context
      )
  }),
  defineMethod({
    name: 'speech.dictation.start',
    params: DictationStart,
    handler: async (params, context) => {
      const { runtime, clientId, connectionId } = context
      let modelId = params.modelId
      if (!supportsOpenRouter(context)) {
        const setup = await runtime.listMobileSpeechModels()
        modelId ||= setup.selectedModelId
        if (!modelId) {
          throw new Error('voice_model_not_selected')
        }
        if (setup.models.some((model) => model.id === modelId && model.provider === 'openrouter')) {
          throw new Error(
            'voice_model_not_ready:Update this client to use OpenRouter, or select a supported model on desktop.'
          )
        }
      }
      // Pin the inspected selection so a settings change cannot route audio to a hidden provider.
      return runtime.startMobileDictation({
        ...params,
        ...(modelId !== undefined ? { modelId } : {}),
        clientId,
        connectionId
      })
    }
  }),
  defineMethod({
    name: 'speech.dictation.chunk',
    params: DictationChunk,
    handler: (params, { runtime, clientId, connectionId }) =>
      runtime.feedMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.finish',
    params: DictationHandle,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.finishMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.cancel',
    params: DictationHandle,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.cancelMobileDictation({ ...params, clientId, connectionId })
  })
]
