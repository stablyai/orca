import { OpaqueIdSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'

/** Opaque to the cloud: the machine encodes [repoHostId, repoId], or a folder's project group. */
export const PlaceIdSchema = z.string().min(1).max(512)

export const CONNECTOR_HOST_RUNTIMES = ['serve', 'desktop'] as const

export const ConnectorHostDescription = {
  hostName: z.string().min(1),
  platform: z.string().min(1),
  runtime: z.enum(CONNECTOR_HOST_RUNTIMES),
  orcaVersion: z.string().min(1),
  // The display name of the Orca account signed in on the machine, which teammates see their shared
  // bots by; the cloud cleans it as it does every label. Absent from an older machine.
  ownerName: z.string().min(1).max(CONNECTOR_LIMITS.maxDisplayTextLength).optional()
}

// webhook: a hook's calls. orca: a teammate's message to a bot shared with them (share-messages.ts).
export const CONNECTOR_SOURCES = ['slack', 'discord', 'linear', 'github', 'webhook', 'orca'] as const
// Sources with places a bot acts or listens in, and people who ask it there: neither a hook nor Orca has any.
export const CONNECTOR_PLACE_SOURCES = ['slack', 'discord', 'linear', 'github'] as const
export type ConnectorPlaceSource = (typeof CONNECTOR_PLACE_SOURCES)[number]

// A conversation a source's adapter serves. A share's is apart: it has no adapter, only its deliveries.
export const ConnectorConversationSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES).exclude(['orca']),
  externalId: OpaqueIdSchema
})
export type ConnectorConversation = z.infer<typeof ConnectorConversationSchema>

// A share's one ordered queue in the inbox, named by the share's id (share-messages.ts).
export const ConnectorShareConversationSchema = z.object({
  source: z.literal('orca'),
  externalId: OpaqueIdSchema
})
// Any inbox row's conversation.
export const ConnectorInboxConversationSchema = z.union([
  ConnectorConversationSchema,
  ConnectorShareConversationSchema
])
export type ConnectorInboxConversation = z.infer<typeof ConnectorInboxConversationSchema>

// Whom a bot's chat acts for, as its thread row keeps it: the owner, one member (a source user id), or
// anyone the bot takes requests from.
export const ConnectorActsForSchema = z.union([
  z.literal('owner'),
  z.literal('anyone'),
  z.string().regex(/^member:\S{1,128}$/)
])
export type ConnectorActsFor = z.infer<typeof ConnectorActsForSchema>

// Whom the turn behind a bot's post acts for, as its host says: someone_else keeps the post from
// counting as the owner's on Slack (item 167), and none, sent for a chat other than the calling one,
// keeps it from counting as anyone's. Absent from an older machine, which reads as the owner.
export const ConnectorTurnForSchema = z.enum(['owner', 'someone_else', 'none'])
export type ConnectorTurnFor = z.infer<typeof ConnectorTurnForSchema>

// Why a bot's post can't wake an Orca bot it mentions, for the posting turn to read.
export const ConnectorPostNoticesSchema = z.array(z.string().min(1).max(500)).max(10)
