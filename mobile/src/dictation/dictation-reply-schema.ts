import { z } from 'zod'
import type { RuntimeSpeechModelSummary } from '../../../src/shared/runtime-worktree-contracts'
import { hostUnionArms, salvagedOptional, salvagingArray } from '../../../src/shared/zod-salvage'

export const SPEECH_MODEL_PROVIDERS = hostUnionArms<RuntimeSpeechModelSummary['provider']>({
  local: true,
  openai: true
})
export const SPEECH_MODEL_STATUSES = hostUnionArms<RuntimeSpeechModelSummary['status']>({
  ready: true,
  'not-downloaded': true,
  downloading: true,
  extracting: true,
  error: true
})

// Require id because download/delete/select send it back to the host; drop unaddressable rows.
// Unknown provider/status arms degrade to absent under consumers’ equality guards; label/size/progress also have fallbacks, while recommended uses truthiness.
const speechModelSchema = z.looseObject({
  id: z.string(),
  label: salvagedOptional('label', z.string()),
  provider: salvagedOptional('provider', z.enum(SPEECH_MODEL_PROVIDERS)),
  status: salvagedOptional('status', z.enum(SPEECH_MODEL_STATUSES)),
  sizeBytes: salvagedOptional('sizeBytes', z.number().nullable()),
  progress: salvagedOptional('progress', z.number().nullable()),
  recommended: z.unknown().optional()
})

// Require models because the sheet calls some/map unguarded; list, delete and config-write replies all replace the displayed setup.
// Preserve unknown dictationMode strings and absent mode: consumers compare toggle/hold. enabled and selectedModelId have guarded fallbacks.
export const dictationSetupSchema = z.looseObject({
  enabled: salvagedOptional('enabled', z.boolean()),
  selectedModelId: salvagedOptional('selectedModelId', z.string()),
  dictationMode: salvagedOptional('dictationMode', z.string()),
  models: salvagingArray(speechModelSchema)
})

export type MobileSpeechSetupReply = z.output<typeof dictationSetupSchema>
export type MobileSpeechModelReply = MobileSpeechSetupReply['models'][number]

// Download/start/chunk/cancel consumers read only acceptance, so require no reply members.
// Finish stays unchecked: use-mobile-dictation reads the guarded transcript only after its staleness check; schema failure before that check would report superseded work.
export const dictationUnreadReplySchema = z.unknown()
