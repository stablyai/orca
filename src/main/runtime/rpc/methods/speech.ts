import { defineMethod } from '../core'
import {
  DictationChunk,
  DictationHandle,
  DictationSetup,
  DictationStart,
  SpeechModelAction,
  SpeechProviderAction,
  SpeechProviderConfigure,
  SpeechProviderKeySave
} from '../../../../shared/rpc-contract/speech-params'

export const SPEECH_METHODS = [
  defineMethod({
    name: 'speech.models.list',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.listMobileSpeechModels()
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
    handler: async (params, { runtime }) => runtime.deleteMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.dictation.setup',
    permission: 'workspace',
    params: DictationSetup,
    handler: async (params, { runtime }) =>
      runtime.configureMobileDictation({
        ...(params.enabled !== undefined ? { enabled: params.enabled } : {}),
        ...(params.modelId !== undefined ? { modelId: params.modelId } : {}),
        ...(params.dictationMode !== undefined ? { dictationMode: params.dictationMode } : {})
      })
  }),
  defineMethod({
    name: 'speech.dictation.start',
    permission: 'workspace',
    params: DictationStart,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.startMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.chunk',
    permission: 'workspace',
    params: DictationChunk,
    handler: (params, { runtime, clientId, connectionId }) =>
      runtime.feedMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.finish',
    permission: 'workspace',
    params: DictationHandle,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.finishMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.dictation.cancel',
    permission: 'workspace',
    params: DictationHandle,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.cancelMobileDictation({ ...params, clientId, connectionId })
  }),
  defineMethod({
    name: 'speech.providers.list',
    permission: 'workspace',
    params: null,
    handler: async (_params, { runtime }) => runtime.listMobileSpeechProviders()
  }),
  defineMethod({
    name: 'speech.providers.saveKey',
    permission: 'settings-write',
    params: SpeechProviderKeySave,
    handler: async (params, { runtime }) => runtime.saveMobileSpeechProviderKey(params)
  }),
  defineMethod({
    name: 'speech.providers.clearKey',
    permission: 'settings-write',
    params: SpeechProviderAction,
    handler: async (params, { runtime }) => runtime.clearMobileSpeechProviderKey(params)
  }),
  defineMethod({
    name: 'speech.providers.testKey',
    permission: 'workspace',
    params: SpeechProviderAction,
    handler: async (params, { runtime }) => runtime.testMobileSpeechProviderKey(params)
  }),
  defineMethod({
    name: 'speech.providers.configure',
    permission: 'settings-write',
    params: SpeechProviderConfigure,
    handler: async (params, { runtime }) =>
      runtime.configureMobileSpeechProviders(
        params.language !== undefined ? { language: params.language } : {}
      )
  })
]
