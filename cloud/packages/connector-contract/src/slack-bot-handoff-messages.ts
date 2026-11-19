import { z } from 'zod'

// POST `bots/<bot id>/slack/handoffs`, by the bot's own host: a single-use code (5 minutes) that lets
// another signed-in Orca account create the bot's app with its own config grant. A new code replaces
// the last one for that bot and workspace.
export const ConnectorBotSlackHandOffRequestSchema = z.object({
  v: z.literal(1),
  teamId: z.string().min(1)
})
export const ConnectorBotSlackHandOffResponseSchema = z.object({
  code: z.string().min(1),
  expiresAt: z.number().int().positive()
})

// POST `slack/handoffs/redeem`, by the redeeming account's own desktop: the bot, host and workspace come
// only from the code, and only the caller's own grant is spent.
export const ConnectorSlackHandOffRedeemRequestSchema = z.object({
  v: z.literal(1),
  code: z.string().min(1).max(128)
})
export const ConnectorSlackHandOffRedeemResponseSchema = z.object({
  teamId: z.string().min(1),
  appId: z.string().min(1),
  authorizeUrl: z.string().url(),
  expiresAt: z.number().int().positive()
})

export type ConnectorBotSlackHandOffRequest = z.infer<typeof ConnectorBotSlackHandOffRequestSchema>
export type ConnectorBotSlackHandOffResponse = z.infer<
  typeof ConnectorBotSlackHandOffResponseSchema
>
export type ConnectorSlackHandOffRedeemRequest = z.infer<
  typeof ConnectorSlackHandOffRedeemRequestSchema
>
export type ConnectorSlackHandOffRedeemResponse = z.infer<
  typeof ConnectorSlackHandOffRedeemResponseSchema
>
