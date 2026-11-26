import { z } from 'zod'
import { ConnectorContextItem } from '../../shared/connector-asker-contract'

export const feishuStoredContext = z
  .string()
  .nullable()
  .transform((raw) => z.array(ConnectorContextItem).parse(raw ? JSON.parse(raw) : []))

export const feishuHistoryMessage = z.object({
  message_id: z.string(),
  chat_id: z.string(),
  create_time: z.string().regex(/^\d+$/),
  msg_type: z.string(),
  deleted: z.boolean().optional(),
  sender: z.object({
    id: z.string().min(1).max(128),
    id_type: z.string(),
    sender_type: z.string()
  }),
  body: z.object({ content: z.string() })
})
type HistoryMessage = z.infer<typeof feishuHistoryMessage>
const object = z.record(z.string(), z.unknown())

function cardText(value: unknown): string {
  const node = object.safeParse(value).data
  if (!node) {
    return ''
  }
  if (['markdown', 'plain_text', 'lark_md'].includes(String(node.tag))) {
    return typeof node.content === 'string' ? node.content : ''
  }
  return node.tag === 'div' ? cardText(node.text) : ''
}

function messageText(message: HistoryMessage): string {
  try {
    const body = object.parse(JSON.parse(message.body.content))
    if (message.msg_type === 'text') {
      return z.string().parse(body.text)
    }
    if (message.msg_type === 'interactive') {
      const elements = object.safeParse(body.body).data?.elements ?? body.elements
      return Array.isArray(elements) ? elements.map(cardText).filter(Boolean).join('\n') : ''
    }
    if (message.msg_type === 'post') {
      const post = Array.isArray(body.content)
        ? body
        : object.parse(body.zh_cn ?? body.en_us ?? Object.values(body)[0])
      const rows = z.array(z.array(object)).parse(post.content)
      return [
        typeof post.title === 'string' ? post.title : '',
        ...rows.map((row) =>
          row
            .map((node) =>
              typeof node.text === 'string'
                ? node.text
                : node.tag === 'at'
                  ? `@${String(node.user_name ?? node.user_id)}`
                  : `[${String(node.tag)}]`
            )
            .join('')
        )
      ].join('\n')
    }
    return `[${message.msg_type} message; attachment contents not included]`
  } catch {
    return '[message content could not be read]'
  }
}

export function feishuHistoryContext(
  items: HistoryMessage[],
  request: { chat_id: string; message_id: string; create_time: string },
  owner: string | null
): ConnectorContextItem[] {
  const earlier = [...new Map(items.map((item) => [item.message_id, item])).values()]
    .filter(
      (item) =>
        !item.deleted &&
        item.chat_id === request.chat_id &&
        item.message_id !== request.message_id &&
        Number(item.create_time) < Number(request.create_time)
    )
    .sort((a, b) => Number(b.create_time) - Number(a.create_time))
  const context: ConnectorContextItem[] = []
  let remaining = 20_000
  let cut = earlier.length > 20
  for (const item of earlier.slice(0, 20)) {
    const raw = messageText(item).trim()
    if (!raw) {
      continue
    }
    if (remaining <= 0) {
      cut = true
      break
    }
    const limit = Math.min(2000, remaining)
    const text = raw.length > limit ? `${raw.slice(0, limit)}\n[truncated]` : raw
    cut ||= raw.length > limit
    remaining -= text.length
    if (item.sender.sender_type === 'user' && item.sender.id_type === 'open_id') {
      context.push({
        kind: item.sender.id === owner ? 'earlier' : 'no_access',
        userId: item.sender.id,
        name: item.sender.id === owner ? 'paired owner' : item.sender.id,
        text
      })
    } else {
      context.push({ kind: 'bot', name: item.sender.id, text })
    }
  }
  return [...(cut ? [{ kind: 'more' as const }] : []), ...context.toReversed()]
}
