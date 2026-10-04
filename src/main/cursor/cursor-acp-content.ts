import { z } from 'zod'
import type { NativeChatTextBlock } from '../../shared/native-chat-types'
import {
  boundPayload,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'

const uri = z.string().min(1).max(4096)
const binary = z.object({ data: z.string(), mimeType: z.string().min(1).max(256) })
const contentSchema = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  binary.extend({ type: z.literal('image') }),
  binary.extend({ type: z.literal('audio') }),
  z.object({
    type: z.literal('resource_link'),
    uri,
    name: z.string().max(512),
    title: z.string().max(512).optional()
  }),
  z.object({
    type: z.literal('resource'),
    resource: z.union([
      z.object({ uri, text: z.string(), mimeType: z.string().max(256).optional() }),
      z.object({ uri, blob: z.string(), mimeType: z.string().max(256).optional() })
    ])
  })
])

export function cursorAcpMessageContent(value: unknown): {
  text: string
  block?: NativeChatTextBlock
} {
  const content = contentSchema.parse(value)
  if (content.type === 'text') {
    return { text: content.text }
  }
  if (content.type === 'resource_link') {
    return { text: `${content.title ?? content.name}: ${content.uri}` }
  }
  if (content.type === 'resource' && 'text' in content.resource) {
    return { text: `${content.resource.uri}\n${content.resource.text}` }
  }
  const text = 'Cursor sent content Orca cannot display yet'
  return {
    text,
    block: {
      type: 'text',
      text,
      providerFrame: {
        provider: 'cursor',
        kind: `content:${content.type}`,
        payload: boundPayload(JSON.stringify(content), DEFAULT_JOURNAL_PAYLOAD_LIMITS)
      }
    }
  }
}
