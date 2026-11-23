import { OpaqueIdSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'

// POST `…/links/preview` and `…/links/confirm`: the first-use link Linear showed a person who asked a
// bot while unlinked, as the desktop received it from orca://linear/link?t=<token>.
export const ConnectorLinearLinkTokenRequestSchema = z.object({
  v: z.literal(1),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/)
})

// Who the link names, for the account to confirm before anything is linked. The handle and email
// are Linear's and can't be borrowed; a display name can. So can a workspace name: urlKey (its
// linear.app/<urlKey>) is unique, kept from when the link was made. Absent from older links.
export const ConnectorLinearLinkPreviewSchema = z.object({
  userName: z.string(),
  userHandle: z.string(),
  userEmail: z.string(),
  workspaceName: z.string(),
  urlKey: z.string().optional()
})

// The Linear workspaces the account's user is linked in, whether Orca is installed there, and the
// bot their requests go to when they name none (one of the account's own; null for none).
export const ConnectorLinearStateSchema = z.object({
  // Where a workspace admin installs Orca.
  installUrl: z.string().url(),
  workspaces: z.array(
    z.object({
      workspaceId: z.string(),
      name: z.string(),
      urlKey: z.string(),
      installed: z.boolean(),
      userId: z.string(),
      userName: z.string(),
      defaultBotId: z.string().nullable()
    })
  )
})

// Active members of a Linear workspace by name, for a bot's Who can ask; guests and apps are left
// out. complete is false when more matched than one answer holds. handle (Linear's display name) and
// avatarUrl are left out when they have none; older desktops ignore them.
export const ConnectorLinearMembersResponseSchema = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      handle: z.string().optional(),
      avatarUrl: z.string().optional()
    })
  ),
  complete: z.boolean()
})

// PUT: the bot the account's Linear user's requests go to in that workspace when they name none
// (one of the account's own bots there), or null for none.
export const ConnectorLinearDefaultBotRequestSchema = z.object({
  v: z.literal(1),
  botId: OpaqueIdSchema.nullable()
})

// A comment the bot posts on a Linear issue (its key, e.g. ENG-123) on its own, such as an
// automation's result. Retries with one postId post once.
export const ConnectorBotLinearCommentRequestSchema = z.object({
  v: z.literal(1),
  postId: OpaqueIdSchema,
  issue: z.string().regex(/^[A-Za-z0-9]{1,16}-[0-9]{1,9}$/),
  text: z
    .string()
    .min(1)
    .max(64 * 1024)
})

export type ConnectorLinearLinkTokenRequest = z.infer<typeof ConnectorLinearLinkTokenRequestSchema>
export type ConnectorLinearLinkPreview = z.infer<typeof ConnectorLinearLinkPreviewSchema>
export type ConnectorLinearState = z.infer<typeof ConnectorLinearStateSchema>
export type ConnectorLinearMembersResponse = z.infer<typeof ConnectorLinearMembersResponseSchema>
export type ConnectorLinearDefaultBotRequest = z.infer<
  typeof ConnectorLinearDefaultBotRequestSchema
>
export type ConnectorBotLinearCommentRequest = z.infer<
  typeof ConnectorBotLinearCommentRequestSchema
>
