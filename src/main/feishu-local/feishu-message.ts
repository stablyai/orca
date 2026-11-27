import { z } from 'zod'

export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'
const messageKind = z.enum(['text', 'image', 'file', 'post'])
const text = z.object({ text: z.string().refine((s) => s.trim().length > 0 && !s.includes('\0')) })
const event = z.object({
  app_id: z.string(),
  event_id: z.string().min(1).max(256),
  sender: z.object({
    sender_type: z.literal('user'),
    sender_id: z.object({ open_id: z.string().regex(/^ou_[a-zA-Z0-9_-]{1,120}$/) })
  }),
  message: z.object({
    message_id: z.string().regex(/^om_[a-zA-Z0-9_-]{1,120}$/),
    chat_id: z.string().regex(/^oc_[a-zA-Z0-9_-]{1,120}$/),
    chat_type: z.enum(['p2p', 'group']),
    message_type: messageKind,
    create_time: z.string().regex(/^\d{13}$/),
    content: z
      .string()
      .min(1)
      .max(64 * 1024)
  })
})

type Message = z.infer<typeof event>['message']
export type FeishuMessage = Message & {
  type?: typeof FEISHU_MESSAGE_EVENT
  sender_id: string
  event_id: string
  sender_type?: 'user' | 'bot'
  root_id?: string
  reply_to?: string
  thread_id?: string
  mentions?: { id: string; key: string; name?: string }[]
}

export function messageText(raw: string): string | undefined {
  try {
    return text.safeParse(JSON.parse(raw)).data?.text
  } catch {
    return undefined
  }
}

export function readFeishuMessage(value: unknown, appId: string): FeishuMessage | null {
  // EventDispatcher flattens the authenticated long-connection envelope's header and event.
  const { data } = event.safeParse(value)
  if (!data || data.app_id !== appId) {
    return null
  }
  const content =
    data.message.message_type === 'text' ? messageText(data.message.content) : data.message.content
  return content
    ? {
        ...data.message,
        content,
        event_id: data.event_id,
        sender_id: data.sender.sender_id.open_id
      }
    : null
}

export function verifiedOriginal(
  items: unknown,
  mid: string,
  chat: string,
  owner: string,
  kind: Message['message_type']
): string | undefined {
  return z
    .tuple([
      z.object({
        message_id: z.literal(mid),
        chat_id: z.literal(chat),
        msg_type: z.literal(kind),
        deleted: z.literal(false).optional(),
        sender: z.object({
          id_type: z.literal('open_id'),
          sender_type: z.literal('user'),
          id: z.literal(owner)
        }),
        body: z.object({ content: z.string().max(64 * 1024) })
      })
    ])
    .safeParse(items).data?.[0].body.content
}

export function matchesPairingOriginal(items: unknown, message: FeishuMessage): boolean {
  const raw = verifiedOriginal(
    items,
    message.message_id,
    message.chat_id,
    message.sender_id,
    'text'
  )
  return raw !== undefined && messageText(raw) === message.content
}
