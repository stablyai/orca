import { z } from 'zod'

// Zoho's data centers Cliq runs in, by the `location` its OAuth redirect names. China needs its own
// client registration and is not offered.
export const CLIQ_DATA_CENTERS = ['us', 'eu', 'in', 'au', 'jp', 'ca', 'sa', 'uk'] as const
export type CliqDataCenter = (typeof CLIQ_DATA_CENTERS)[number]

// A Cliq organization as the owner's sign-in reached it; dataCenter picks its API and web host.
export const ConnectorCliqOrgSchema = z.object({
  orgId: z.string().min(1).max(64),
  name: z.string(),
  dataCenter: z.enum(CLIQ_DATA_CENTERS)
})

// GET `cliq/state`: the organizations the account signed in to, and as whom. DELETE
// `cliq/orgs/<org id>` forgets one; its bots stay in Cliq but stop answering until it is back.
export const ConnectorCliqStateSchema = z.object({
  orgs: z.array(
    ConnectorCliqOrgSchema.extend({
      userId: z.string().min(1),
      userName: z.string(),
      // Zoho refused the refresh token: signing in again fixes it.
      expired: z.literal(true).optional()
    })
  )
})

// POST `bots/<bot id>/cliq/bots`: create the bot's Cliq bot in an organization the account signed
// in to, or repair an existing one's handlers.
export const ConnectorBotCliqCreateRequestSchema = z.object({
  v: z.literal(1),
  orgId: z.string().min(1).max(64)
})

// - installed: the Cliq bot exists and its handlers call Orca Cloud.
// - broken: Orca made it but can't reach it now; `reason` says what fixes it (grant_expired: sign
//   in again; bot_deleted: someone deleted it in Cliq, so setting up again makes a new one).
export const ConnectorBotCliqStateSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_created') }),
  z.object({
    state: z.literal('installed'),
    orgId: z.string(),
    // Cliq's id, and the unique name posts as the bot name; unique_name never changes.
    cliqBotId: z.string(),
    uniqueName: z.string(),
    installerUserId: z.string(),
    dataCenter: z.enum(CLIQ_DATA_CENTERS),
    orgName: z.string().optional(),
    installerName: z.string().optional(),
    // Its handlers predate this cloud's: setting up again adds the new ones.
    updateNeeded: z.literal(true).optional()
  }),
  z.object({
    state: z.literal('broken'),
    orgId: z.string(),
    reason: z.enum(['grant_expired', 'bot_deleted'])
  })
])

// GET `bots/<bot id>/cliq` (`?org=` names one): that organization's state, or the first's, with
// every organization's in `orgs`, oldest first.
export const ConnectorBotCliqStateResponseSchema = ConnectorBotCliqStateSchema.and(
  z.object({ orgs: z.array(ConnectorBotCliqStateSchema).optional() })
)

// GET `bots/<bot id>/cliq/members?org=&q=`: the organization's active users whose names match,
// for the bot's Who can ask. Cliq publishes no picture URL, so there is none.
export const ConnectorBotCliqMembersResponseSchema = z.object({
  members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string().optional() })),
  complete: z.boolean()
})

export type ConnectorCliqOrg = z.infer<typeof ConnectorCliqOrgSchema>
export type ConnectorCliqState = z.infer<typeof ConnectorCliqStateSchema>
export type ConnectorBotCliqCreateRequest = z.infer<typeof ConnectorBotCliqCreateRequestSchema>
export type ConnectorBotCliqState = z.infer<typeof ConnectorBotCliqStateSchema>
export type ConnectorBotCliqStateResponse = z.infer<typeof ConnectorBotCliqStateResponseSchema>
export type ConnectorBotCliqMembersResponse = z.infer<typeof ConnectorBotCliqMembersResponseSchema>
