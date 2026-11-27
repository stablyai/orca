import { lazyZodSchema } from '../../shared/schema/lazy-zod-schema'
import { z } from 'zod'
import { feishuCommand, type FeishuMessage } from './feishu-cli'
import type { Binding } from './feishu-binding'
import type { BotMember } from '../../shared/bot-types'
import type { ConnectorContextItem } from '../../shared/connector-asker-contract'
import { feishuHistoryContext, feishuHistoryMessage } from './feishu-history-context'

const messages = lazyZodSchema(() =>
  z.object({
    ok: z.literal(true),
    identity: z.literal('bot'),
    data: z.object({
      items: z
        .array(feishuHistoryMessage.nullable().catch(null))
        .default([])
        .transform((items) => items.filter((item) => item !== null)),
      has_more: z.boolean().optional()
    })
  })
)

export async function feishuThreadContext(
  b: Binding,
  m: FeishuMessage,
  signal: AbortSignal,
  members: () => readonly BotMember[]
): Promise<ConnectorContextItem[]> {
  const parent = m.root_id || m.reply_to
  const groupHistory = m.chat_type === 'group' && !m.thread_id && !parent
  if (!m.thread_id && !parent && !groupHistory) {
    return []
  }
  try {
    const requests: Promise<unknown>[] = []
    const args = ['--profile', b.app, 'api', 'GET']
    if (m.thread_id || groupHistory) {
      requests.push(
        feishuCommand(
          [
            ...args,
            '/open-apis/im/v1/messages',
            '--as',
            'bot',
            '--params',
            JSON.stringify({
              container_id_type: groupHistory ? 'chat' : 'thread',
              container_id: groupHistory ? m.chat_id : m.thread_id,
              sort_type: 'ByCreateTimeDesc',
              page_size: 50,
              end_time: String(Math.ceil(Number(m.create_time) / 1000)),
              card_msg_content_type: 'user_card_content'
            })
          ],
          signal
        )
      )
    }
    // Feishu's thread list excludes the root message.
    if (parent && parent !== m.message_id) {
      requests.push(
        feishuCommand(
          [
            ...args,
            `/open-apis/im/v1/messages/${parent}`,
            '--as',
            'bot',
            '--params',
            '{"card_msg_content_type":"user_card_content"}'
          ],
          signal
        )
      )
    }
    const results = await Promise.allSettled(
      requests.map(async (request) => messages.parse(await request).data)
    )
    if (results.every((result) => result.status === 'rejected')) {
      return [{ kind: 'unreadable' }]
    }
    const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value.items : []))
    const context = feishuHistoryContext(items, m, b, members())
    if (results.some((r) => r.status === 'rejected')) {
      context.unshift({ kind: 'unreadable' })
    }
    if (
      results.some((r) => r.status === 'fulfilled' && r.value.has_more) &&
      !context.some((item) => item.kind === 'more')
    ) {
      context.unshift({ kind: 'more' })
    }
    return context
  } catch {
    signal.throwIfAborted()
    return [{ kind: 'unreadable' }]
  }
}
