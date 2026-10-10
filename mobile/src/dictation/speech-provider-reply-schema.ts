import { z } from 'zod'
import type {
  RuntimeSpeechProviderModel,
  RuntimeSpeechProviderSummary
} from '../../../src/shared/runtime-speech-provider-contracts'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

// The provider cabinet's reads and writes (`speech.providers.*`), checked against the shared
// RuntimeSpeechProvidersState in src/shared/runtime-speech-provider-contracts.ts.

export const SPEECH_PROVIDER_KINDS = hostUnionArms<RuntimeSpeechProviderSummary['kind']>({
  local: true,
  cloud: true
})
export const SPEECH_PROVIDER_MODEL_STATUSES = hostUnionArms<RuntimeSpeechProviderModel['status']>({
  ready: true,
  'not-downloaded': true,
  downloading: true,
  extracting: true,
  error: true
})

/**
 * One model row. `id` is required because it is what the select/download sends put back on the
 * wire; everything else is decoration or an equality test, so an unreadable member degrades to
 * absent instead of dropping the row.
 */
const speechProviderModelSchema = z.looseObject({
  id: z.string(),
  label: salvagedOptional('label', z.string()),
  description: salvagedOptional('description', z.string()),
  realtime: salvagedOptional('realtime', z.boolean()),
  // Why: absent (older desktop) means unknown, so every language stays offered; null means the model picks its own.
  languages: salvagedOptional('languages', z.array(z.string()).nullable()),
  sizeBytes: salvagedOptional('sizeBytes', z.number().nullable()),
  recommended: salvagedOptional('recommended', z.boolean()),
  status: salvagedOptional('status', z.enum(SPEECH_PROVIDER_MODEL_STATUSES)),
  progress: salvagedOptional('progress', z.number().nullable())
})

/**
 * One provider. `id` stays an open string: a provider a newer desktop adds still renders (with a
 * monogram fallback) and its key can still be saved, because the phone only echoes the id back.
 */
const speechProviderSchema = z.looseObject({
  id: z.string(),
  kind: salvagedOptional('kind', z.enum(SPEECH_PROVIDER_KINDS)),
  label: salvagedOptional('label', z.string()),
  description: salvagedOptional('description', z.string()),
  keyConfigured: salvagedOptional('keyConfigured', z.boolean()),
  keyHint: salvagedOptional('keyHint', z.string().nullable()),
  keyUrl: salvagedOptional('keyUrl', z.string().nullable()),
  keyPlaceholder: salvagedOptional('keyPlaceholder', z.string().nullable()),
  models: salvagingArray(speechProviderModelSchema)
})

/** Every cabinet write answers with the whole state again, so one schema covers all of them. */
export const speechProvidersStateSchema = z.looseObject({
  enabled: salvagedOptional('enabled', z.boolean()),
  selectedModelId: salvagedOptional('selectedModelId', z.string()),
  dictationMode: salvagedOptional('dictationMode', z.string()),
  language: salvagedOptional('language', z.string()),
  providers: salvagingArray(speechProviderSchema)
})

export const speechProviderKeyTestSchema = z.looseObject({
  ok: z.boolean(),
  message: salvagedOptional('message', z.string().nullable())
})

export type MobileSpeechProvidersState = z.output<typeof speechProvidersStateSchema>
export type MobileSpeechProvider = MobileSpeechProvidersState['providers'][number]
export type MobileSpeechProviderModel = MobileSpeechProvider['models'][number]
export type MobileSpeechProviderKeyTest = z.output<typeof speechProviderKeyTestSchema>
