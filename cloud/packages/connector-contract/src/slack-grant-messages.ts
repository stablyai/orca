import { z } from 'zod'

// The refresh token from Slack's "Your App Configuration Tokens", spent at once and never stored.
export const ConnectorSlackGrantRequestSchema = z.object({
  v: z.literal(1),
  refreshToken: z.string().startsWith('xoxe-').max(2048)
})

// The workspace the token belongs to, as Slack reported it.
export const ConnectorSlackGrantResponseSchema = z.object({ teamId: z.string().min(1) })

export type ConnectorSlackGrantRequest = z.infer<typeof ConnectorSlackGrantRequestSchema>
export type ConnectorSlackGrantResponse = z.infer<typeof ConnectorSlackGrantResponseSchema>
