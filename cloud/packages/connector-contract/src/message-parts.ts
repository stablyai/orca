import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'

// What a message holds beyond its words: files, messages shared into it, and link previews. Shared
// messages and previews come only in an answer to read's `only`, for the one message it names; each
// part is bounded so a message's parts stay small.
export const MESSAGE_PART_LIMITS = {
  // Files on a message, counting those inside its shared messages.
  maxFiles: 10,
  maxShared: 3,
  maxLinks: 3,
  maxSharedText: 2_000,
  maxSharedUrl: 512,
  maxRef: 120,
  maxLinkUrl: 1_000,
  maxLinkTitle: 200,
  maxLinkText: 500
} as const

// A file posted on a message, or inside a message shared into it: its id downloads it through that
// message (`read <message> --download <id>`); the shared message's own channel may be closed to the bot.
export const ConnectorMessageFileSchema = z.object({
  id: z.string(),
  // As Slack names it, whole: saving the file uses it.
  name: z.string().max(1024),
  type: z.string().optional(),
  size: z.number().int().nonnegative().optional()
})
export type ConnectorMessageFile = z.infer<typeof ConnectorMessageFileSchema>

// A message shared (forwarded) into another, or a link to one that Slack previewed: who wrote it, a
// ref that reads it (`read <ref> --only`), its link, and its words. cut: its words were shortened.
export const ConnectorSharedMessageSchema = z.object({
  author: z.string().max(CONNECTOR_LIMITS.maxDisplayTextLength).optional(),
  ref: z.string().min(1).max(MESSAGE_PART_LIMITS.maxRef).optional(),
  url: z.string().min(1).max(MESSAGE_PART_LIMITS.maxSharedUrl).optional(),
  at: z.number().int().nonnegative().optional(),
  text: z.string().max(MESSAGE_PART_LIMITS.maxSharedText),
  cut: z.literal(true).optional(),
  files: z.array(ConnectorMessageFileSchema).max(MESSAGE_PART_LIMITS.maxFiles).optional()
})
export type ConnectorSharedMessage = z.infer<typeof ConnectorSharedMessageSchema>

// A link's preview as the source showed it under the message.
export const ConnectorLinkPreviewSchema = z.object({
  url: z.string().min(1).max(MESSAGE_PART_LIMITS.maxLinkUrl),
  title: z.string().max(MESSAGE_PART_LIMITS.maxLinkTitle).optional(),
  text: z.string().max(MESSAGE_PART_LIMITS.maxLinkText).optional()
})
export type ConnectorLinkPreview = z.infer<typeof ConnectorLinkPreviewSchema>

// partsLeftOut: how many parts past the limits aren't sent.
export const ConnectorMessagePartsFields = {
  files: z.array(ConnectorMessageFileSchema).max(MESSAGE_PART_LIMITS.maxFiles).optional(),
  shared: z.array(ConnectorSharedMessageSchema).max(MESSAGE_PART_LIMITS.maxShared).optional(),
  links: z.array(ConnectorLinkPreviewSchema).max(MESSAGE_PART_LIMITS.maxLinks).optional(),
  partsLeftOut: z.number().int().positive().optional()
}
export const ConnectorMessagePartsSchema = z.object(ConnectorMessagePartsFields)
export type ConnectorMessageParts = z.infer<typeof ConnectorMessagePartsSchema>
