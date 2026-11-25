import { defineMethod } from '../../core'
import {
  DictationChunk,
  DictationHandle,
  DictationSetup,
  DictationStart,
  OpenAiSpeechKeySet,
  SpeechModelAction,
  SpeechSetupRead
} from '../../../../../shared/rpc-contract/speech/speech-params'

export const SPEECH_METHODS = [
  defineMethod({
    name: 'speech.models.list',
    permission: 'workspace',
    share: 'not-shared',
    params: SpeechSetupRead,
    handler: async (params, { runtime }) => runtime.listMobileSpeechModels(params?.worktreeId)
  }),
  defineMethod({
    name: 'speech.models.download',
    permission: 'workspace',
    share: 'not-shared',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.downloadMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.models.delete',
    permission: 'workspace',
    share: 'not-shared',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.deleteMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.dictation.setup',
    permission: 'workspace',
    share: 'not-shared',
    params: DictationSetup,
    handler: async (params, { runtime }) =>
      runtime.configureMobileDictation({
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
        ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {}),
        ...(params.dictationHoldToRecord !== undefined
          ? { dictationHoldToRecord: params.dictationHoldToRecord }
          : {})
      })
  }),
  defineMethod({
    name: 'speech.dictation.start',
    permission: 'workspace',
    share: 'not-shared',
    params: DictationStart,
    handler: async (params, { runtime, clientId }) =>
      runtime.startMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.chunk',
    permission: 'workspace',
    share: 'not-shared',
    params: DictationChunk,
    handler: (params, { runtime, clientId }) => runtime.feedMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.finish',
    permission: 'workspace',
    share: 'not-shared',
    params: DictationHandle,
    handler: async (params, { runtime, clientId }) =>
      runtime.finishMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.cancel',
    permission: 'workspace',
    share: 'not-shared',
    params: DictationHandle,
    handler: async (params, { runtime, clientId }) =>
      runtime.cancelMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.openAiKey.status',
    permission: 'workspace',
    share: 'not-shared',
    params: null,
    handler: async (_params, { runtime }) => runtime.getOpenAiSpeechKeyStatus()
  }),
  defineMethod({
    name: 'speech.openAiKey.set',
    permission: 'settings-write',
    share: 'not-shared',
    params: OpenAiSpeechKeySet,
    handler: async (params, { runtime }) => runtime.setOpenAiSpeechKey(params.apiKey)
  }),
  defineMethod({
    name: 'speech.openAiKey.clear',
    permission: 'settings-write',
    share: 'not-shared',
    params: null,
    handler: async (_params, { runtime }) => runtime.clearOpenAiSpeechKey()
  })
]
