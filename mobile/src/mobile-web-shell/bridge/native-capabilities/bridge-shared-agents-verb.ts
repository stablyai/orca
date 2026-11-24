import * as z from 'zod'
import { SHARED_BOT_HELD_STATES } from '../../../../../src/shared/bots/shared-bot-hosts'

// The agents shared with the page's computer's account, as this phone reaches them. The shell serves
// the watch itself, as it serves their calls: their link and held messages now and on each change. The
// verb sends a refused message again; its grant is also how a page knows the shell serves the watch.
export const BRIDGE_SHARED_AGENTS_VERB = 'native.sharedAgents.act'
export const SHARED_AGENTS_WATCH_METHOD = 'sharedAgents.phone.watch'

export const sharedAgentsParamsSchema = z.strictObject({
  action: z.literal('sendAgain'),
  environmentId: z.string().min(1).max(128),
  clientMessageId: z.string().min(1).max(128)
})

const heldSchema = z.object({
  clientMessageId: z.string(),
  sessionId: z.string(),
  text: z.string(),
  attachments: z.array(z.string()),
  sentAt: z.number(),
  state: z.enum(SHARED_BOT_HELD_STATES)
})

export const sharedAgentViewSchema = z.object({
  environmentId: z.string(),
  shareId: z.string(),
  botId: z.string(),
  botName: z.string(),
  ownerName: z.string(),
  homeWorkspaceId: z.string().nullable(),
  link: z.enum(['live', 'connecting', 'offline', 'unpaired']),
  holds: z.boolean(),
  held: z.array(heldSchema)
})

export const sharedAgentsResultSchema = z.strictObject({ sent: z.boolean() })

/** Each event of the watch. */
export const sharedAgentsWatchEventSchema = z.object({ hosts: z.array(sharedAgentViewSchema) })

export type BridgeSharedAgentView = z.infer<typeof sharedAgentViewSchema>
