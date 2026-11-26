import { z } from 'zod'
import { FeishuChatId, FeishuOpenId, type FeishuGroupPolicy } from '../../shared/bots/feishu-local'

export const FEISHU_MESSAGE_EVENT = 'im.message.receive_v1'
const messageKind = z.enum(['text', 'image', 'file', 'post'])
const text = z.object({ text: z.string().refine((s) => s.trim().length > 0 && !s.includes('\0')) })
const messageId = z.string().regex(/^om_[a-zA-Z0-9_-]{1,120}$/)
const message = z.object({
  message_id: messageId,
  chat_id: FeishuChatId,
  message_type: messageKind,
  create_time: z.string().regex(/^\d{13}$/),
  content: z
    .string()
    .min(1)
    .max(64 * 1024)
})
const event = z.object({
  app_id: z.string(),
  event_id: z.string().min(1).max(256),
  sender: z.object({
    sender_type: z.literal('user'),
    sender_id: z.object({ open_id: FeishuOpenId })
  }),
  message: message.extend({ chat_type: z.literal('p2p') })
})

const tenantKey = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const groupEvent = event.extend({
  tenant_key: tenantKey,
  sender: event.shape.sender.extend({ tenant_key: tenantKey }),
  message: message.extend({
    chat_type: z.enum(['group', 'topic_group']),
    message_type: z.literal('text'),
    root_id: messageId.nullish(),
    thread_id: z
      .string()
      .regex(/^omt_[a-zA-Z0-9_-]{1,120}$/)
      .nullish(),
    mentions: z.array(
      z.object({ key: z.string(), id: z.object({ open_id: z.string().nullish() }) })
    )
  })
})

type Message = z.infer<typeof event>['message']
export type FeishuMessage = Message & { sender_id: string; event_id: string }
export const FeishuGroupRoute = z.object({
  chatId: FeishuChatId,
  tenant: tenantKey,
  rootId: messageId,
  inThread: z.boolean(),
  sender: FeishuOpenId
})
export type FeishuGroupRoute = z.infer<typeof FeishuGroupRoute>
export type FeishuGroupMessage = Omit<FeishuMessage, 'chat_type'> & {
  chat_type: 'group' | 'topic_group'
  group: FeishuGroupRoute
}
export type FeishuInboundMessage = FeishuMessage | FeishuGroupMessage

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

export function readFeishuGroupMessage(
  value: unknown,
  appId: string,
  botOpenId: string,
  policy: FeishuGroupPolicy
): FeishuGroupMessage | null {
  const { data } = groupEvent.safeParse(value)
  if (!data || data.app_id !== appId || data.tenant_key !== data.sender.tenant_key) {
    return null
  }
  const { mentions, root_id, thread_id, content, ...original } = data.message
  const sender = data.sender.sender_id.open_id
  if (original.chat_id !== policy.chatId || !policy.members.includes(sender)) {
    return null
  }
  const keys = new Set(
    mentions
      .filter((entry) => entry.id.open_id === botOpenId && /^@_user_\d+$/.test(entry.key))
      .map((entry) => entry.key)
  )
  const prompt = messageText(content)
    ?.replace(/@_user_\d+/g, (key) => (keys.has(key) ? '' : key))
    .trim()
  if (!keys.size || !prompt) {
    return null
  }
  return {
    ...original,
    content: prompt,
    sender_id: sender,
    event_id: data.event_id,
    group: {
      chatId: original.chat_id,
      tenant: data.tenant_key,
      rootId: root_id ?? original.message_id,
      inThread: Boolean(thread_id) || original.chat_type === 'topic_group',
      sender
    }
  }
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
