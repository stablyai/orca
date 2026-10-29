import { z } from 'zod'
import { BRIDGE_MAX_MESSAGE_BYTES } from './bridge-caps'

// JSON can spend 6 bytes on one character (\u0001), so a full request stays under the frame cap.
export const SPEECH_MAX_MARKDOWN_CHARS = Math.floor(BRIDGE_MAX_MESSAGE_BYTES / 8)

// One verb with an action: each verb takes one of the session route's few grants.
// The shell turns the markdown into speech, so page and shell never disagree on what is heard.
export const speechControlParamsSchema = z.strictObject({
  action: z.literal('speak'),
  id: z.string().min(1).max(512),
  markdown: z.string().min(1).max(SPEECH_MAX_MARKDOWN_CHARS)
})

export const speechControlResultSchema = z.strictObject({ accepted: z.boolean() })
