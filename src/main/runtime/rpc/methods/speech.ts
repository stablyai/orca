import { z } from 'zod'
import { defineMethod, type RpcMethod } from '../core'
import { OptionalString, requiredString } from '../schemas'

const AUDIO_BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/
const DICTATION_SAMPLE_RATE = 16_000
const PCM_BYTES_PER_SAMPLE = 2
const MAX_DICTATION_AUDIO_SECONDS = 5
const MAX_DICTATION_AUDIO_CHUNK_BYTES =
  DICTATION_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE * MAX_DICTATION_AUDIO_SECONDS
const MAX_DICTATION_AUDIO_CHUNK_BASE64_LENGTH = Math.ceil(MAX_DICTATION_AUDIO_CHUNK_BYTES / 3) * 4

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
    // Why: feedMobileDictation decodes into Buffer + Float32Array; reject
    // oversized chunks before allocation. This mirrors the mobile pending-audio budget.
    .refine(
      (value) => value.length <= MAX_DICTATION_AUDIO_CHUNK_BASE64_LENGTH,
      'Audio chunk is too large'
    )
    // Why: Buffer.from(..., 'base64') silently drops malformed bytes; reject
    // bad mobile audio chunks instead of feeding empty/corrupt PCM.
    .refine(isValidAudioBase64, 'Audio chunk must be base64'),
  sampleRate: z.number().finite().positive()
})

const DictationHandle = z.object({
  dictationId: requiredString('Missing dictation ID')
})

const SpeechModelAction = z.object({
  modelId: requiredString('Missing model ID')
})

const DictationSetup = z.object({
  enabled: z.boolean().optional(),
  modelId: OptionalString,
  dictationMode: z.enum(['toggle', 'hold']).optional()
})

export const SPEECH_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'speech.models.list',
    params: null,
    handler: async (_params, { runtime }) => runtime.listMobileSpeechModels()
  }),
  defineMethod({
    name: 'speech.models.download',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.downloadMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.models.delete',
    params: SpeechModelAction,
    handler: async (params, { runtime }) => runtime.deleteMobileSpeechModel(params.modelId)
  }),
  defineMethod({
    name: 'speech.dictation.setup',
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
