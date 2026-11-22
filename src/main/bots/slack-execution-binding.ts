import { z } from 'zod'
import { ConnectorSlackRequester } from '../../shared/connector-asker-contract'

export const SlackExecutionBinding = z.object({
  botId: z.string().min(1),
  workspaceId: z.string().min(1),
  operationId: z.string().min(1),
  reply: z.object({
    account: z.string().min(1),
    conversation: z.object({ source: z.literal('slack'), externalId: z.string().min(1) }),
    deliveryId: z.string().min(1)
  }),
  requester: ConnectorSlackRequester.nullable()
})

export type SlackExecutionBinding = z.infer<typeof SlackExecutionBinding>
