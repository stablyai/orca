import { defineMethod, type RpcContext } from '../../core'
import { CHATGPT_SPEECH_ACCOUNTS_CLIENT_CAPABILITY } from '../../../../../shared/speech/speech-types'
import type { RuntimeSpeechSetupState } from '../../../../../shared/worktree/catalog/runtime-worktree-contracts'
import {
  DictationChunk,
  DictationHandle,
  DictationSetup,
  DictationStart,
  OpenAiSpeechKeySet,
  SpeechModelAction,
  SpeechSetupRead
} from '../../../../../shared/rpc-contract/speech/speech-params'

function speechSetupForClient(
  setup: RuntimeSpeechSetupState,
  context: Pick<RpcContext, 'clientKind' | 'clientCapabilities'>
): RuntimeSpeechSetupState {
  if (
    context.clientKind !== 'mobile' ||
    context.clientCapabilities?.includes(CHATGPT_SPEECH_ACCOUNTS_CLIENT_CAPABILITY)
  ) {
    return setup
  }
  return { ...setup, models: setup.models.filter((model) => model.provider !== 'chatgpt') }
}

export const SPEECH_METHODS = [
  defineMethod({
    name: 'speech.models.list',
    permission: 'workspace',
    params: SpeechSetupRead,
    handler: async (params, context) =>
      speechSetupForClient(
        await context.runtime.listMobileSpeechModels(params?.worktreeId),
        context
      )
  }),
  defineMethod({
    name: 'speech.models.download',
    permission: 'workspace',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.downloadMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.models.delete',
    permission: 'workspace',
    params: SpeechModelAction,
    handler: async (params, context) =>
      speechSetupForClient(await context.runtime.deleteMobileSpeechModel(params.modelId), context)
  }),
  defineMethod({
    name: 'speech.dictation.setup',
    permission: 'workspace',
    params: DictationSetup,
    handler: async (params, context) =>
      speechSetupForClient(
        await context.runtime.configureMobileDictation({
          ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
          ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
          ...(params.chatGptAccountId !== undefined
            ? { chatGptAccountId: params.chatGptAccountId }
            : {}),
          ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {}),
          ...(params.dictationHoldToRecord !== undefined
            ? { dictationHoldToRecord: params.dictationHoldToRecord }
            : {})
        }),
        context
      )
  }),
  defineMethod({
    name: 'speech.dictation.start',
    permission: 'workspace',
    params: DictationStart,
    handler: async (params, { runtime, clientId }) =>
      runtime.startMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.chunk',
    permission: 'workspace',
    params: DictationChunk,
    handler: (params, { runtime, clientId }) => runtime.feedMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.finish',
    permission: 'workspace',
    params: DictationHandle,
    handler: async (params, { runtime, clientId }) =>
      runtime.finishMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.cancel',
    permission: 'workspace',
    params: DictationHandle,
    handler: async (params, { runtime, clientId }) =>
      runtime.cancelMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.openAiKey.status',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.getOpenAiSpeechKeyStatus()
  }),
  defineMethod({
    name: 'speech.openAiKey.set',
    permission: 'settings-write',
    params: OpenAiSpeechKeySet,
    handler: async (params, { runtime }) => runtime.setOpenAiSpeechKey(params.apiKey)
  }),
  defineMethod({
    name: 'speech.openAiKey.clear',
    permission: 'settings-write',
    params: null,
    handler: async (_params, { runtime }) => runtime.clearOpenAiSpeechKey()
  })
]
