import { z } from 'zod'

// Why: well above the desktop's 8000-character reply cap and well below the bridge frame bound.
export const SPEECH_MAX_TEXT_CHARS = 200_000

// Why: one verb with an action, since each verb takes one of the session route's few grants; the
// shell turns the markdown into speech itself, so page and shell never disagree on what is heard.
export const speechControlParamsSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('speak'),
    id: z.string().min(1).max(512),
    markdown: z.string().min(1).max(SPEECH_MAX_TEXT_CHARS)
  }),
  z.strictObject({ action: z.literal('stop') })
])

export const speechControlResultSchema = z.strictObject({ accepted: z.boolean() })

export type SpeechControlParams = z.infer<typeof speechControlParamsSchema>
