import { randomUUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { providerImageData } from './provider-image-input'

export function claudeUserMessage(
  text: string,
  imagePaths?: readonly string[],
  clientMessageId: string = randomUUID()
): SDKUserMessage {
  const content: SDKUserMessage['message']['content'] = [
    ...(text ? [{ type: 'text' as const, text }] : []),
    ...(imagePaths ?? []).map((path) => {
      const image = providerImageData(path)
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: image.mediaType, data: image.data }
      }
    })
  ]
  return {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
    uuid: clientMessageId as ReturnType<typeof randomUUID>
  }
}
