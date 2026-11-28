import { OpaqueIdSchema } from '@orca-cloud/push-contract'
import { z } from 'zod'
import { ConnectorTurnForSchema } from './connector-wire-scalars.js'

// The workspace whose config grant creates the bot's app.
export const ConnectorBotSlackAppRequestSchema = z.object({
  v: z.literal(1),
  teamId: z.string().min(1)
})

// Slack's install link for the bot's app; each one supersedes the last and lives 30 minutes, until
// `expiresAt` (ms; left out by an older cloud).
export const ConnectorBotSlackAppResponseSchema = z.object({
  appId: z.string().min(1),
  authorizeUrl: z.string().url(),
  expiresAt: z.number().int().positive().optional()
})

// The latest install attempt was approved by a Slack user other than the one allowed to install.
const OAuthFailure = { oauthFailure: z.literal('other_user').optional() }

// - created: the app exists and waits for its Install click (or a workspace admin's approval).
// - uncertain: Slack may have created an app Orca holds no secrets for, or the app's events are not
//   on yet; setting up again finishes it or makes a new one.
// - grant_expired: as uncertain, with no config grant left to continue; a new paste fixes it.
export const ConnectorBotSlackStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_created') }),
  z.object({ state: z.literal('uncertain'), teamId: z.string(), ...OAuthFailure }),
  z.object({ state: z.literal('grant_expired'), teamId: z.string(), ...OAuthFailure }),
  z.object({
    state: z.literal('created'),
    teamId: z.string(),
    appId: z.string(),
    ...OAuthFailure
  }),
  z.object({
    state: z.literal('installed'),
    teamId: z.string(),
    appId: z.string(),
    botUserId: z.string(),
    installerUserId: z.string(),
    // For showing; left out when Slack could not say just now.
    teamName: z.string().optional(),
    installerName: z.string().optional(),
    // The app's manifest predates this cloud's: setting it up again adds the new scopes and events.
    updateNeeded: z.literal(true).optional(),
    // The app works as it is, yet predates optional scopes this cloud's manifest asks for: setting it
    // up again grants them. Offered, never asked for.
    updateAvailable: z.literal(true).optional()
  })
])

// GET (`?team=` names a workspace): the bot's Slack in that workspace, or with none named in its
// first. A cloud that lists `slack.teams` adds every workspace's, oldest first; an older desktop
// reads only the single state.
export const ConnectorBotSlackStateResponseSchema = ConnectorBotSlackStateSchema.and(
  z.object({ teams: z.array(ConnectorBotSlackStateSchema).optional() })
)

// The people of the bot's workspace who may be on Who can ask, and other Slack apps, by name.
// complete is false when the workspace is too large to read whole, so someone may be missing.
// avatarUrl is Slack's picture of them; left out when they have none, or by an older cloud.
// app: another Slack app's bot user (its name already says "(app)"), never Slackbot or an Orca bot.
export const ConnectorBotSlackMembersResponseSchema = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      avatarUrl: z.string().optional(),
      app: z.literal(true).optional()
    })
  ),
  complete: z.boolean()
})

// A message the bot posts in a channel on its own, such as an automation's result. Retries with one
// postId post once.
export const ConnectorBotPostRequestSchema = z.object({
  v: z.literal(1),
  postId: OpaqueIdSchema,
  channelId: z.string().min(1),
  text: z.string().min(1),
  // Its workspace, to a cloud that lists `slack.teams`; without it, the bot's first.
  teamId: z.string().min(1).optional(),
  // Whom the run behind it acts for (see ConnectorTurnForSchema).
  turnFor: ConnectorTurnForSchema.optional()
})

// Orca's mascots, by the id a bot's picture names; the connector holds each one's image.
export const CONNECTOR_BOT_MASCOT_IDS = [
  'A1',
  'B1',
  'D1',
  'E1',
  'F1',
  'G1',
  'H1',
  'H2',
  'I1',
  'J1',
  'K2',
  'L2',
  'M1',
  'N1',
  'O1',
  'P3',
  'Q1',
  'R3',
  'S2',
  'T1'
] as const

// A bot's uploaded picture: a square PNG of 512 to 2000 px, at most this many bytes.
export const CONNECTOR_BOT_AVATAR_MAX_BYTES = 2 * 1024 * 1024

// PUT: the bot's picture, which becomes its Slack app's icon. An upload carries its PNG (base64)
// and the version its machine named it by, so sending one twice sets the icon once.
export const ConnectorBotAvatarRequestSchema = z.discriminatedUnion('kind', [
  z.object({ v: z.literal(1), kind: z.literal('mascot'), id: z.enum(CONNECTOR_BOT_MASCOT_IDS) }),
  z.object({
    v: z.literal(1),
    kind: z.literal('upload'),
    version: z.string().regex(/^[0-9a-f]{16}$/),
    png: z
      .string()
      .max(Math.ceil(CONNECTOR_BOT_AVATAR_MAX_BYTES / 3) * 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/)
  })
])

export type ConnectorBotSlackAppRequest = z.infer<typeof ConnectorBotSlackAppRequestSchema>
export type ConnectorBotSlackAppResponse = z.infer<typeof ConnectorBotSlackAppResponseSchema>
export type ConnectorBotSlackState = z.infer<typeof ConnectorBotSlackStateSchema>
export type ConnectorBotSlackStateResponse = z.infer<typeof ConnectorBotSlackStateResponseSchema>
export type ConnectorBotSlackMembersResponse = z.infer<
  typeof ConnectorBotSlackMembersResponseSchema
>
export type ConnectorBotPostRequest = z.infer<typeof ConnectorBotPostRequestSchema>
export type ConnectorBotAvatarRequest = z.infer<typeof ConnectorBotAvatarRequestSchema>
