import { OpaqueIdSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'

/** Opaque to the cloud: the machine encodes [repoHostId, repoId], or a folder's project group. */
export const PlaceIdSchema = z.string().min(1).max(512)

export const CONNECTOR_HOST_RUNTIMES = ['serve', 'desktop'] as const

export const ConnectorHostDescription = {
  hostName: z.string().min(1),
  platform: z.string().min(1),
  runtime: z.enum(CONNECTOR_HOST_RUNTIMES),
  orcaVersion: z.string().min(1)
}

export const CONNECTOR_SOURCES = ['slack', 'discord', 'linear', 'github', 'webhook'] as const

export const ConnectorConversationSchema = z.object({
  source: z.enum(CONNECTOR_SOURCES),
  externalId: OpaqueIdSchema
})
export type ConnectorConversation = z.infer<typeof ConnectorConversationSchema>

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
