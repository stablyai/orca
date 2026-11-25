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
  const parent = m.root_id || m.reply_to
  if (!m.thread_id && !parent) {
    return ''
  }
  try {
    const requests: Promise<unknown>[] = []
    const args = ['--profile', b.app, 'api', 'GET']
    if (m.thread_id) {
      requests.push(
        feishuCommand(
          [
            ...args,
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
      )
    }
    // Feishu's thread list excludes the root message.
    if (parent && parent !== m.message_id) {
      requests.push(
        feishuCommand([...args, `/open-apis/im/v1/messages/${parent}`, '--as', 'bot'], signal)
      )
    }
    const results = await Promise.allSettled(
      requests.map(async (request) => messages.parse(await request).data.items)
    )
    if (results.every((result) => result.status === 'rejected')) {
      return 'Earlier thread messages could not be read.\n\nCurrent request:\n'
    }
    const items = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
    const lines = [...new Map(items.map((item) => [item.message_id, item])).values()]
      .sort((a, b) => Number(b.create_time) - Number(a.create_time))
      .filter(
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
