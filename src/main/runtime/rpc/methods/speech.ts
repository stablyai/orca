import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const DictationStart = z.object({
  dictationId: requiredString('Missing dictation ID'),
  modelId: OptionalString
})

const DictationChunk = z.object({
  dictationId: requiredString('Missing dictation ID'),
  audioBase64: requiredString('Missing audio chunk'),
  sampleRate: z.number().finite().positive()
})

const DictationHandle = z.object({
  dictationId: requiredString('Missing dictation ID')
})

export const SPEECH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'speech.dictation.start',
    params: DictationStart,
    handler: async (params, { runtime, clientId }) =>
      runtime.startMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.chunk',
    params: DictationChunk,
    handler: (params, { runtime, clientId }) => runtime.feedMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.finish',
    params: DictationHandle,
    handler: async (params, { runtime, clientId }) =>
      runtime.finishMobileDictation({ ...params, clientId })
  }),
  defineMethod({
    name: 'speech.dictation.cancel',
    params: DictationHandle,
    handler: async (params, { runtime, clientId }) =>
      runtime.cancelMobileDictation({ ...params, clientId })
  })
]
