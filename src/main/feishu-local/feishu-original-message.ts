// The owner's original DM message as Feishu holds it, read as the bot and checked against the
// pairing, so what the inbox row claims never picks what Orca downloads.
import { z } from 'zod'
import type { Binding } from './feishu-binding'
import { feishuCommand } from './feishu-cli'

/** The original DM's content, when the owner sent it in the paired chat as this type. */
export function originalContent(
  value: unknown,
  b: Binding,
  mid: string,
  type: string
): string | null {
  const msg = z.object({
    message_id: z.literal(mid),
    chat_id: z.literal(b.chat),
    msg_type: z.literal(type),
    sender: z.object({
      id_type: z.literal('open_id'),
      sender_type: z.literal('user'),
      id: z.literal(b.owner)
    }),
    body: z.object({ content: z.string() })
  })
  return (
    z
      .object({
        ok: z.literal(true),
        identity: z.literal('bot'),
        data: z.object({ items: z.tuple([msg]) })
      })
      .safeParse(value).data?.data.items[0].body.content ?? null
  )
}

const postImage = z.object({
  tag: z.literal('img'),
  image_key: z.string().regex(/^img_[a-zA-Z0-9_-]{1,192}$/)
})

function imageKeysIn(node: unknown, keys: Set<string>): void {
  const image = postImage.safeParse(node)
  if (image.success) {
    keys.add(image.data.image_key)
  } else if (node && typeof node === 'object') {
    for (const child of Object.values(node)) {
      imageKeysIn(child, keys)
    }
  }
}

/** The images a rich-text post holds, in order, whatever its locale wrapping. */
export function postImageKeys(value: unknown, b: Binding, mid: string): string[] {
  const content = originalContent(value, b, mid, 'post')
  const keys = new Set<string>()
  try {
    imageKeysIn(content === null ? null : JSON.parse(content), keys)
  } catch {
    return []
  }
  return [...keys]
}

export function readOriginal(b: Binding, mid: string, signal: AbortSignal): Promise<unknown> {
  return feishuCommand(
    [
      '--profile',
      b.app,
      'api',
      'GET',
      `/open-apis/im/v1/messages/${mid}`,
      '--params',
      '{"user_id_type":"open_id"}',
      '--as',
      'bot'
    ],
    signal
  )
}
