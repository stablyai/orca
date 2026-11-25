import { createHash } from 'node:crypto'
import { z } from 'zod'
import { feishuCommand } from './feishu-cli'
export type FeishuReply = { type: 'text' | 'post' | 'file' | 'interactive'; content: unknown }

/** Replies once per (original, part): Feishu takes a repeated uuid within an hour as the same
 *  message and returns its id. 'final' keeps the uuid older builds used for the answer. */
export async function replyFeishu(
  app: string,
  account: string,
  original: string,
  chat: string,
  message: FeishuReply,
  part: string,
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

/** Replaces a card the bot sent with new content; Feishu shows the newest edit to every reader. */
export async function patchFeishuCard(
  app: string,
  card: string,
  content: string,
  signal: AbortSignal
): Promise<void> {
  const response = await feishuCommand(
    [
      '--profile',
      app,
      'api',
      'PATCH',
      `/open-apis/im/v1/messages/${card}`,
      '--as',
      'bot',
      '--data',
      '-'
    ],
    signal,
    JSON.stringify({ content })
  )
  z.object({ ok: z.literal(true), identity: z.literal('bot') }).parse(response)
}

/** Raw post content never invokes the CLI Markdown helper's URL fetcher. */
export function finalFeishuMessage(text: string): { type: 'post' | 'text'; content: unknown } {
  if (!text.trim() || text.includes('![') || /<img\b/i.test(text)) {
    return { type: 'text', content: { text } }
  }
  return { type: 'post', content: { zh_cn: { title: '', content: [[{ tag: 'md', text }]] } } }
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
