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

export const ConnectorConversationSchema = z.object({
  source: z.literal('slack'),
  externalId: OpaqueIdSchema
})
export type ConnectorConversation = z.infer<typeof ConnectorConversationSchema>
