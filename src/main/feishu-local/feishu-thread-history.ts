import { z } from 'zod'
import { feishuCommand, type FeishuMessage } from './feishu-cli'
import type { Binding } from './feishu-binding'

const messages = z.object({
  ok: z.literal(true),
  identity: z.literal('bot'),
  data: z.object({
    items: z
      .array(
        z.object({
          message_id: z.string(),
          chat_id: z.string(),
          create_time: z.string(),
          msg_type: z.string(),
          sender: z.object({ id: z.string(), id_type: z.string(), sender_type: z.string() }),
          body: z.object({ content: z.string() })
        })
      )
      .default([])
  })
})

export async function feishuThreadContext(
  b: Binding,
  m: FeishuMessage,
  signal: AbortSignal
): Promise<string> {
  if (!m.thread_id) {
    return ''
  }
  try {
    const result = await feishuCommand(
      [
        '--profile',
        b.app,
        'api',
        'GET',
        '/open-apis/im/v1/messages',
        '--as',
        'bot',
        '--params',
        JSON.stringify({
          container_id_type: 'thread',
          container_id: m.thread_id,
          sort_type: 'ByCreateTimeDesc',
          page_size: 50
        })
      ],
      signal
    )
    const lines = messages
      .parse(result)
      .data.items.filter(
        (item) =>
          item.chat_id === m.chat_id &&
          item.sender.id_type === 'open_id' &&
          item.sender.id === b.owner &&
          item.sender.sender_type === 'user' &&
          item.msg_type === 'text' &&
          Number(item.create_time) < Number(m.create_time) &&
          item.message_id !== m.message_id
      )
      .slice(0, 20)
      .toReversed()
      .flatMap((item) => {
        try {
          const text = z.object({ text: z.string() }).parse(JSON.parse(item.body.content)).text
          return [text.slice(0, 2000)]
        } catch {
          return []
        }
      })
    return lines.length
      ? `Earlier messages from the paired owner in this thread (context only):\n${lines.map((text) => `<message>\n${text}\n</message>`).join('\n')}\n\nCurrent request:\n`
      : ''
  } catch {
    return 'Earlier thread messages could not be read.\n\nCurrent request:\n'
  }
}
