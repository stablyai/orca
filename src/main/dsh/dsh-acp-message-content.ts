import { z } from 'zod'
import type { NativeChatBlock } from '../../shared/native-chat-types'

export const DSH_ACP_MESSAGE_MAX_BYTES = 1024 * 1024

const image = z.object({
  type: z.literal('image'),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  data: z
    .string()
    .refine(
      (data) =>
        !/[^A-Za-z0-9+/=]/.test(data) && Buffer.from(data, 'base64').toString('base64') === data,
      'DSH ACP image data must be canonical base64'
    )
})

export const dshAcpMessageContentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  image
])

export function dshAcpImageBlock(content: z.infer<typeof image>): NativeChatBlock {
  const url = `data:${content.mimeType};base64,${content.data}`
  if (Buffer.byteLength(url, 'utf8') > DSH_ACP_MESSAGE_MAX_BYTES) {
    return {
      type: 'text',
      text: `DeepSeek Harness returned a ${content.mimeType} image that exceeds Orca's ${DSH_ACP_MESSAGE_MAX_BYTES}-byte inline limit and cannot be displayed.`
    }
  }
  return { type: 'image-ref', url, alt: 'DeepSeek Harness image' }
}
