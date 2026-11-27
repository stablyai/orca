import { createHash } from 'node:crypto'
import { z } from 'zod'
import { feishuCommand } from './feishu-cli'
export async function replyFeishu(
  app: string,
  account: string,
  original: string,
  chat: string,
  message: { type: 'text' | 'post' | 'interactive' | 'file'; content: unknown },
  part: 'final' | 'file' | `file:${string}` | `reply:${string}` | `card:${string}`,
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
