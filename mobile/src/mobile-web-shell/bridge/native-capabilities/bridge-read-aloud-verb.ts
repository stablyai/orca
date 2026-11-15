import * as z from 'zod'

// The shell speaks with the phone's voice; one verb with an action keeps the session route within the grant ceiling.
// The bridge has no push lane, so speak replies only when the voice finishes or is stopped: that reply is the end signal.
export const BRIDGE_READ_ALOUD_VERB = 'native.voice.act'

export const BRIDGE_READ_ALOUD_MAX_CHARS = 64_000

export const readAloudParamsSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('speak'),
    text: z.string().min(1).max(BRIDGE_READ_ALOUD_MAX_CHARS)
  }),
  z.strictObject({ action: z.literal('stop') })
])

export const readAloudResultSchema = z.strictObject({})
