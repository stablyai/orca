// What one of Orca's own sign-ins keeps, sealed whole in the bot's credential file.
import { z } from 'zod'
import { lazyZodSchema } from '../../../shared/schema/lazy-zod-schema'

/** Everything a sign-in keeps; sealed whole, and never sent to a renderer, an agent or a log. */
export const BotToolOAuthRecordSchema = lazyZodSchema(() =>
  z.object({
    /** The resource indicator exactly as the app's metadata states it, sent on every token request. */
    resource: z.string(),
    /** The authorization server the client and tokens are bound to. */
    issuer: z.string().optional(),
    resourceMetadataUrl: z.string().optional(),
    scope: z.string().optional(),
    /** The registration Orca got from the authorization server, for `redirectUri` only. */
    client: z
      .looseObject({
        client_id: z.string(),
        client_secret: z.string().optional(),
        client_id_issued_at: z.number().optional(),
        client_secret_expires_at: z.number().optional()
      })
      .optional(),
    redirectUri: z.string().optional(),
    tokens: z
      .looseObject({
        access_token: z.string(),
        token_type: z.string(),
        refresh_token: z.string().optional(),
        expires_in: z.number().optional(),
        scope: z.string().optional()
      })
      .optional(),
    /** When `tokens` arrived; `expires_in` counts from here. */
    obtainedAt: z.number().optional(),
    /** Why the app refused the stored sign-in, so the row asks for a new one. */
    lost: z.enum(['grant', 'client']).optional(),
    /** Why the last sign-in couldn't start; cleared by the next sign-in or a sign-out. */
    problem: z.enum(['unsupported', 'unreachable']).optional()
  })
)
export type BotToolOAuthRecord = z.infer<typeof BotToolOAuthRecordSchema>
