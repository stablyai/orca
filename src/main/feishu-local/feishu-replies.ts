import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Binding } from './feishu-binding'
import type { FeishuStore } from './feishu-store-ops'
import { feishuCommand } from './feishu-cli'
export async function replyFeishu(
  app: string,
  account: string,
  original: string,
  chat: string,
  message: { type: 'text' | 'post' | 'interactive' | 'file'; content: unknown },
  part: 'final' | 'file' | `reply:${string}`,
  signal: AbortSignal
): Promise<string> {
  const uuid = createHash('sha256')
    .update(JSON.stringify(part === 'final' ? [account, original] : [account, original, part]))
    .digest('hex')
    .slice(0, 48)
  // Body on stdin also keeps long replies within Windows' command-line limit.
  const response = await feishuCommand(
    [
      '--profile',
      app,
      'api',
      'POST',
      `/open-apis/im/v1/messages/${original}/reply`,
      '--as',
      'bot',
      '--data',
      '-'
    ],
    signal,
    JSON.stringify({ msg_type: message.type, content: JSON.stringify(message.content), uuid })
  )
  return z
    .object({
      ok: z.literal(true),
      identity: z.literal('bot'),
      data: z.object({
        chat_id: z.literal(chat),
        message_id: z.string().regex(/^om_[a-zA-Z0-9_-]+$/)
      })
    })
    .parse(response).data.message_id
}

/** Raw card content never invokes the CLI Markdown helper's URL fetcher. */
export function feishuReplyMessage(
  text: string,
  botName: string
): { type: 'interactive' | 'post' | 'text'; content: unknown } {
  const structured = /^ {0,3}(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|`{3}|~{3}|\|.+\|)/m.test(text)
  if (!text.trim() || text.includes('![') || /<img\b/i.test(text)) {
    return { type: 'text', content: { text } }
  }
  if (!structured && text.length <= 240) {
    return { type: 'post', content: { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } } }
  }
  return {
    type: 'interactive',
    content: {
      schema: '2.0',
      config: {
        update_multi: true,
        width_mode: 'default',
        summary: { content: [...text.trim().replace(/\s+/g, ' ')].slice(0, 160).join('') }
      },
      header: {
        title: { tag: 'plain_text', content: botName },
        template: 'default',
        icon: { tag: 'standard_icon', token: 'ai-common_colorful' }
      },
      body: {
        direction: 'vertical',
        padding: '12px 12px 20px 12px',
        elements: [{ tag: 'markdown', content: text, text_size: 'normal' }]
      }
    }
  }
}
export async function uploadFeishuFile(
  app: string,
  name: string,
  bytes: Uint8Array | null,
  signal: AbortSignal
): Promise<string> {
  if (!bytes) {
    throw new Error('File content is unavailable')
  }
  const reply = await feishuCommand(
    [
      '--profile',
      app,
      'api',
      'POST',
      '/open-apis/im/v1/files',
      '--as',
      'bot',
      '--file',
      'file=-',
      '--data',
      JSON.stringify({ file_type: 'stream', file_name: name })
    ],
    signal,
    bytes
  )
  return z
    .object({
      ok: z.literal(true),
      identity: z.literal('bot'),
      data: z.object({ file_key: z.string().regex(/^file_[a-zA-Z0-9_-]+$/) })
    })
    .parse(reply).data.file_key
}

/** A best-effort receipt on the original message consumes no reply in the chat. */
export async function acknowledgeFeishuMessage(
  inbox: FeishuStore,
  b: Binding,
  mid: string,
  signal: AbortSignal,
  active: () => boolean
): Promise<void> {
  if (
    !b.chat ||
    signal.aborted ||
    !active() ||
    !(await inbox.takeProgress(b.account, mid)) ||
    !active()
  ) {
    return
  }
  await feishuCommand(
    [
      '--profile',
      b.app,
      'api',
      'POST',
      `/open-apis/im/v1/messages/${mid}/reactions`,
      '--as',
      'bot',
      '--data',
      '-'
    ],
    signal,
    JSON.stringify({ reaction_type: { emoji_type: 'OK' } })
  ).catch(() => {})
}
