import { OpaqueIdSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'

// A GitHub user or organization login: letters, digits and hyphens, not starting with a hyphen,
// and the underscore of an enterprise-managed user's suffix (mona-cat_octo). Older accounts may have
// hyphens newer ones can't.
export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,38}$/
// GitHub's numeric ids travel as digit strings.
export const GITHUB_ID_PATTERN = /^[1-9][0-9]{0,19}$/

const GitHubUserSchema = z.object({
  // The only thing a comment's author is matched on.
  userId: z.string().regex(GITHUB_ID_PATTERN),
  login: z.string().regex(GITHUB_LOGIN_PATTERN)
})

// GET `${github}/state`: the GitHub user the account is linked as, the Orca app's installations that
// user can reach, and the bot their requests go to when they name none.
export const ConnectorGitHubStateSchema = z.object({
  installUrl: z.string().url(),
  account: GitHubUserSchema.nullable(),
  installations: z.array(
    z.object({
      installationId: z.string().regex(GITHUB_ID_PATTERN),
      accountLogin: z.string().regex(GITHUB_LOGIN_PATTERN),
      // Null when the app may use every repository of that account.
      repositories: z.array(z.object({ fullName: z.string().min(1) })).nullable()
    })
  ),
  defaultBotId: z.string().nullable()
})

// POST `${github}/links` {v:1}: GitHub's sign-in page (identity only) for this account.
export const ConnectorGitHubLinkStartRequestSchema = z.object({ v: z.literal(1) })
export const ConnectorGitHubLinkStartSchema = z.object({ authorizeUrl: z.string().url() })

// The single-use token the browser that finished a GitHub sign-in hands to Orca
// (orca://github/link?t=<token>), as Linear's link token; it lives 10 minutes.
export const GITHUB_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

// POST `${github}/links/preview` (whom the token names; it stays usable) and `…/links/confirm`
// ("This is me": links them, spending it). Only the account that started the sign-in may redeem it;
// others get 409 wrong_account, and an expired token 409 expired. Links are many-to-many, so a
// second GitHub user links beside the first.
export const ConnectorGitHubLinkTokenRequestSchema = z.object({
  v: z.literal(1),
  token: z.string().regex(GITHUB_LINK_TOKEN_PATTERN)
})
export const ConnectorGitHubLinkPreviewSchema = GitHubUserSchema.extend({
  // Their GitHub display name; empty when they set none.
  name: z.string()
})

// GET `${github}/users?q=<username>`: the GitHub user with exactly that login, as {id: numeric id,
// name: login}, for a bot's Who can ask; the same shape as Linear's members.
export const ConnectorGitHubUsersResponseSchema = z.object({
  members: z.array(
    z.object({
      id: z.string().regex(GITHUB_ID_PATTERN),
      name: z.string().regex(GITHUB_LOGIN_PATTERN)
    })
  ),
  complete: z.boolean()
})

// PUT `${github}/default-bot`: one of the account's own bots on GitHub, or null for none.
export const ConnectorGitHubDefaultBotRequestSchema = z.object({
  v: z.literal(1),
  botId: OpaqueIdSchema.nullable()
})

export type ConnectorGitHubState = z.infer<typeof ConnectorGitHubStateSchema>
export type ConnectorGitHubLinkStart = z.infer<typeof ConnectorGitHubLinkStartSchema>
export type ConnectorGitHubLinkPreview = z.infer<typeof ConnectorGitHubLinkPreviewSchema>
export type ConnectorGitHubUsersResponse = z.infer<typeof ConnectorGitHubUsersResponseSchema>
