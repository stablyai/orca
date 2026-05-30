import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const AUDIO_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

function isValidAudioBase64(value: string): boolean {
  return value.length % 4 !== 1 && AUDIO_BASE64_PATTERN.test(value)
}

const DictationStart = z.object({
  dictationId: requiredString('Missing dictation ID'),
  modelId: OptionalString
})

const DictationChunk = z.object({
  dictationId: requiredString('Missing dictation ID'),
  audioBase64: requiredString('Missing audio chunk')
    // Why: Buffer.from(..., 'base64') silently drops malformed bytes; reject
    // bad mobile audio chunks instead of feeding empty/corrupt PCM.
    .refine(isValidAudioBase64, 'Audio chunk must be base64'),
  sampleRate: z.number().finite().positive()
})

const DictationHandle = z.object({
  dictationId: requiredString('Missing dictation ID')
})

export const SPEECH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'speech.dictation.start',
    params: DictationStart,
    handler: async (params, { runtime, clientId, connectionId }) =>
      runtime.startMobileDictation({ ...params, clientId, connectionId })
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
