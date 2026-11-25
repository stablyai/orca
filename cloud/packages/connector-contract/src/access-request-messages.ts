import { EpochMsSchema, OpaqueIdSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { CONNECTOR_LIMITS } from './connector-limits.js'

// "Request access": someone a bot doesn't take asked its owner to be added. The cloud records who
// asked from the source's signed payload; only the owner's own Orca adds them, through its usual
// People with access path.

// The token from orca://bot/access-request?t=<token> (the owner's "Review in Orca").
export const ACCESS_REQUEST_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

// POST `${accessRequests}/redeem`: the link works once, and only for the bot owner's account.
// botIds, when sent, are the bots the redeeming machine has: a token for another bot is left
// unspent for the machine that has it. Older machines send none.
export const ConnectorAccessRequestRedeemSchema = z.object({
  v: z.literal(1),
  token: z.string().regex(ACCESS_REQUEST_TOKEN_PATTERN),
  botIds: z
    .array(OpaqueIdSchema)
    .max(CONNECTOR_LIMITS.maxHelloBots * CONNECTOR_LIMITS.maxBotPages)
    .optional()
})

// One pending request, as its source verified the person. handle is Slack's username or Linear's
// display name, which anyone can edit and repeat; detail is Slack's real name or the email Linear
// verified, which is what identifies a Linear person.
export const ConnectorAccessRequestSchema = z.object({
  requestId: OpaqueIdSchema,
  botId: OpaqueIdSchema,
  source: z.enum(['slack', 'linear']),
  workspaceId: z.string().min(1),
  workspaceName: z.string(),
  requester: z.object({
    id: z.string().min(1),
    name: z.string(),
    handle: z.string(),
    detail: z.string(),
    // Slack's picture of them; left out for Linear, or by a cloud that predates it.
    avatarUrl: z.string().optional()
  }),
  createdAt: EpochMsSchema,
  expiresAt: EpochMsSchema
})

// GET `${accessRequests}`: the account's pending requests, newest first. granted holds recent grants
// whose bot has not yet listed the person, so an Orca whose add failed can finish it.
export const ConnectorAccessRequestListSchema = z.object({
  requests: z.array(ConnectorAccessRequestSchema),
  granted: z.array(ConnectorAccessRequestSchema).optional()
})

// POST `${accessRequests}/<request id>/decision`: granted once the owner's Orca added them, declined
// on Cancel or Decline. Either closes the request.
export const ConnectorAccessRequestDecisionSchema = z.object({
  v: z.literal(1),
  decision: z.enum(['granted', 'declined'])
})

export type ConnectorAccessRequest = z.infer<typeof ConnectorAccessRequestSchema>
export type ConnectorAccessRequestList = z.infer<typeof ConnectorAccessRequestListSchema>
export type ConnectorAccessRequestDecision = z.infer<typeof ConnectorAccessRequestDecisionSchema>
