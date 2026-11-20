import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'

// What a message holds beyond its words: files, messages shared into it, and link previews. Sent only
// to a machine that lists messageParts; each is bounded so a message's parts stay small.
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

// A file posted on a message: its id downloads it (`read <message> --download <id>`).
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

// partsLeftOut: how many parts past the limits (or past a delivery's or read's budget) aren't sent.
export const ConnectorMessagePartsFields = {
  files: z.array(ConnectorMessageFileSchema).max(MESSAGE_PART_LIMITS.maxFiles).optional(),
  shared: z.array(ConnectorSharedMessageSchema).max(MESSAGE_PART_LIMITS.maxShared).optional(),
  links: z.array(ConnectorLinkPreviewSchema).max(MESSAGE_PART_LIMITS.maxLinks).optional(),
  partsLeftOut: z.number().int().positive().optional()
}
export const ConnectorMessagePartsSchema = z.object(ConnectorMessagePartsFields)
export type ConnectorMessageParts = z.infer<typeof ConnectorMessagePartsSchema>

const partCount = (parts: ConnectorMessageParts) =>
  (parts.files?.length ?? 0) +
  (parts.shared ?? []).reduce((sum, shared) => sum + 1 + (shared.files?.length ?? 0), 0) +
  (parts.links?.length ?? 0)

/** Messages in the order they matter (the asker first, then newest), their parts kept while their JSON
 *  fits maxBytes; a message past it keeps its words and ref and counts its parts as left out. */
export function budgetMessageParts<T extends ConnectorMessageParts>(messages: T[], maxBytes: number): T[] {
  let used = 0
  return messages.map((message) => {
    const { files, shared, links, partsLeftOut, ...rest } = message
    const parts = { files, shared, links }
    const count = partCount(parts)
    if (count === 0) {
      return message
    }
    const bytes = new TextEncoder().encode(JSON.stringify(parts)).length
    if (used + bytes <= maxBytes) {
      used += bytes
      return message
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only the optional part fields are dropped.
    return { ...rest, partsLeftOut: (partsLeftOut ?? 0) + count } as T
  })
}
