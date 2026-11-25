import { EpochMsSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { ConnectorMessageFileSchema } from './action-messages.js'
import { CONNECTOR_LIMITS } from './connector-limits.js'

// One of the asker's own messages before a bare mention. Its text may be empty when it carries files
// or a shared message. `cut`, `shared` and `filesMore` mark what isn't carried: the machine shows that
// part as missing and the bot asks for it rather than acting on it.
export const ConnectorEarlierOwnMessageSchema = z.object({
  text: z.string().max(CONNECTOR_LIMITS.maxEarlierOwnText),
  at: EpochMsSchema,
  // The message as an action ref (slack:T:C:thread:ts), for `read <ref> --download <file id>`.
  messageRef: z.string().min(1).max(2048).optional(),
  files: z.array(ConnectorMessageFileSchema).max(CONNECTOR_LIMITS.maxEarlierOwnFiles).optional(),
  filesMore: z.literal(true).optional(),
  shared: z.literal(true).optional(),
  cut: z.literal(true).optional()
})

// A bare mention's request: the asker's own messages in the thread before the mention, after the bot's
// last post there, oldest first, chosen by the cloud on the source's author id. Only on a bare mention,
// and only when the cloud read that whole stretch; absent otherwise, and the machine then greets.
// `more`: they wrote more than these; these are the newest.
export const ConnectorEarlierOwnSchema = z.object({
  messages: z
    .array(ConnectorEarlierOwnMessageSchema)
    .min(1)
    .max(CONNECTOR_LIMITS.maxEarlierOwnMessages),
  more: z.literal(true).optional()
})
export type ConnectorEarlierOwn = z.infer<typeof ConnectorEarlierOwnSchema>
