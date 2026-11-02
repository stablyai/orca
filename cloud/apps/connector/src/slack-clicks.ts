import { z } from 'zod'

const BlockActionsSchema = z.looseObject({
  type: z.literal('block_actions'),
  api_app_id: z.string().min(1),
  team: z.looseObject({ id: z.string().min(1) }),
  user: z.looseObject({ id: z.string().min(1) }),
  channel: z.looseObject({ id: z.string().min(1) }),
  container: z.looseObject({ message_ts: z.string().min(1) }),
  actions: z
    .array(z.looseObject({ action_id: z.string(), value: z.string().min(1).optional() }))
    .min(1)
})

// A press of an answer button on a prompt card. What it answers is found from the message it is
// on; the button only says which option.
export type SlackClick = {
  // The app Slack delivered it for; must be the app whose URL received it.
  appId: string
  teamId: string
  channelId: string
  userId: string
  messageTs: string
  optionId: string
}

// Slack sends interactions form-encoded, the JSON in `payload`. Other interactions are ignored.
export function readSlackClick(rawBody: string): SlackClick | 'ignored' | 'invalid' {
  let payload: unknown
  try {
    payload = JSON.parse(new URLSearchParams(rawBody).get('payload') ?? '')
  } catch {
    return 'invalid'
  }
  const parsed = BlockActionsSchema.safeParse(payload)
  if (!parsed.success) {
    return typeof payload === 'object' && payload !== null ? 'ignored' : 'invalid'
  }
  const [action] = parsed.data.actions
  if (!action?.action_id.startsWith('answer:') || action.value === undefined) {
    return 'ignored'
  }
  return {
    appId: parsed.data.api_app_id,
    teamId: parsed.data.team.id,
    channelId: parsed.data.channel.id,
    userId: parsed.data.user.id,
    messageTs: parsed.data.container.message_ts,
    optionId: action.value
  }
}
