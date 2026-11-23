import { z } from 'zod'
import { NATIVE_CHAT_AGENTS } from '../../shared/agent-launch/permissions/agent-chat-permission-support'
import {
  CONNECTOR_SOURCES,
  SLACK_MIRROR_BLOCKS,
  SLACK_MIRROR_POST_STATES,
  type ExternalConversationLink
} from '../../shared/connectors/external-conversation-link'

// A terminal pane's link from an older Orca has no session and is skipped.
const ExternalConversationLinkSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: z.string(),
  sessionId: z.string().min(1),
  agent: z.enum(NATIVE_CHAT_AGENTS),
  paneKey: z.string(),
  bot: z.object({ kind: z.enum(['bot', 'bot-chat']), botId: z.string().min(1) }).optional(),
  title: z.string().optional(),
  place: z.string().optional(),
  lastTurn: z.enum(['conversation', 'orca']).optional(),
  adoptedTurn: z.object({ itemId: z.string().min(1), at: z.number().positive() }).optional(),
  wakeAnswers: z
    .object({
      runs: z.array(z.string().min(1).max(512)).min(1).max(32)
    })
    .optional()
    .catch(undefined),
  seenAt: z.number().nullable().optional(),
  // Mirror facts read loosely: a malformed one is dropped alone, never the link.
  opener: z
    .object({
      role: z.enum(['owner', 'member']),
      name: z.string().max(200).optional(),
      dm: z.literal(true).optional()
    })
    .optional()
    .catch(undefined),
  mirror: z.boolean().optional().catch(undefined),
  mirrorBlocked: z.enum(SLACK_MIRROR_BLOCKS).optional().catch(undefined),
  mirrorPosts: z
    .record(
      z.string(),
      z.object({
        state: z.enum(SLACK_MIRROR_POST_STATES),
        at: z.number(),
        error: z.string().max(64).optional()
      })
    )
    .optional()
    .catch(undefined),
  mirrorChosen: z.literal(true).optional().catch(undefined),
  mirrorExternal: z.boolean().optional().catch(undefined),
  mirrorHeld: z
    .array(z.object({ event: z.unknown(), waiting: z.array(z.string()) }))
    .optional()
    .catch(undefined),
  createdAt: z.number()
})

// Cache only objects freshly constructed by ExternalConversationLinkSchema so raw caller inputs always validate.
const parsedLinkObjects = new WeakMap<object, ExternalConversationLink>()

export function parseExternalConversationLink(entry: unknown): ExternalConversationLink | null {
  if (typeof entry === 'object' && entry !== null) {
    const cached = parsedLinkObjects.get(entry)
    if (cached) {
      return cached
    }
  }
  const parsed = ExternalConversationLinkSchema.safeParse(entry)
  if (!parsed.success) {
    return null
  }
  parsedLinkObjects.set(parsed.data, parsed.data)
  return parsed.data
}

export function linksOf(value: unknown): ExternalConversationLink[] {
  if (!Array.isArray(value) || value.length === 0) {
    return []
  }
  const result: ExternalConversationLink[] = []
  for (const entry of value) {
    const parsed = parseExternalConversationLink(entry)
    if (parsed) {
      result.push(parsed)
    }
  }
  return result
}
