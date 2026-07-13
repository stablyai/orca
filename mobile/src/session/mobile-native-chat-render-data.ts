import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { foldToolMessages } from './mobile-native-chat-blocks'
import { stripNoiseMessages } from './mobile-native-chat-noise'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

export function statusHint(status: MobileNativeChatStatus, error?: string): string | null {
  switch (status) {
    case 'waiting-session':
      return 'Waiting for the agent to start its session…'
    case 'error':
      return error ?? 'Could not load the conversation.'
    default:
      return null
  }
}

/** Derive the list data from the raw transcript: fold tool turns into the
 *  assistant turn, optionally append a synthetic streaming bubble, then the
 *  route-owned optimistic "queued" messages at the tail. Returns the
 *  intermediate `folded`/`streaming` so the caller can memoize on them. */
export function buildMobileNativeChatData({
  messages,
  streamingText,
  pending
}: {
  messages: NativeChatMessage[]
  streamingText?: string
  pending: Array<{ id: string; text: string }>
}): { folded: NativeChatMessage[]; streaming: string | null; data: NativeChatMessage[] } {
  const folded = foldMobileNativeChatMessages(messages)
  return buildMobileNativeChatTransientData({ folded, streamingText, pending })
}

export function foldMobileNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  return foldToolMessages(stripNoiseMessages(messages))
}

export function buildMobileNativeChatTransientData({
  folded,
  streamingText,
  pending
}: {
  folded: NativeChatMessage[]
  streamingText?: string
  pending: Array<{ id: string; text: string }>
}): { folded: NativeChatMessage[]; streaming: string | null; data: NativeChatMessage[] } {
  // Only show the streaming bubble while its text leads the transcript — once the
  // real assistant turn lands with the same text, drop the synthetic one.
  const streaming = deriveStreaming(folded, streamingText)
  const data: NativeChatMessage[] = [
    ...folded,
    ...(streaming
      ? [
          {
            id: 'streaming',
            role: 'assistant' as const,
            blocks: [{ type: 'text' as const, text: streaming }],
            timestamp: null,
            source: 'hook' as const
          }
        ]
      : []),
    ...pending.map((p) => ({
      id: p.id,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: p.text }],
      timestamp: null,
      source: 'transcript' as const
    }))
  ]
  return { folded, streaming, data }
}

function deriveStreaming(folded: NativeChatMessage[], streamingText?: string): string | null {
  const text = streamingText?.trim()
  if (!text) {
    return null
  }
  const last = folded[folded.length - 1]
  const lastText =
    last?.role === 'assistant'
      ? last.blocks
          .filter((b) => b.type === 'text')
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('')
          .trim()
      : ''
  if (lastText.includes(text) || text.length <= lastText.length) {
    return null
  }
  return text
}
