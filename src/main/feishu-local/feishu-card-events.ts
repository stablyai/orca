import { z } from 'zod'

const click = z.object({
  type: z.literal('card.action.trigger'),
  operator_id: z.string().regex(/^ou_[a-zA-Z0-9_-]+$/),
  message_id: z.string().regex(/^om_[a-zA-Z0-9_-]+$/),
  chat_id: z.string().regex(/^oc_[a-zA-Z0-9_-]+$/),
  host: z.literal('im_message'),
  action_tag: z.literal('button'),
  action_value: z.string()
})
const choice = z.object({ orca: z.literal('answer'), option: z.string().min(1).max(256) })
export function readFeishuClick(line: string) {
  try {
    const event = click.parse(JSON.parse(line))
    return { ...event, option: choice.parse(JSON.parse(event.action_value)).option }
  } catch {
    return null
  }
}
