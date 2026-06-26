import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  deriveNativeChatStreamingText,
  nativeChatStreamingMessage
} from '../../../src/shared/native-chat-streaming'
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
  agentWorking = streamingText != null,
  pending
}: {
  messages: NativeChatMessage[]
  streamingText?: string
  /** Defaults to "streamingText present" for back-compat; pass the live working
   *  flag so a stale preview from a finished turn never shows. */
  agentWorking?: boolean
  pending: Array<{ id: string; text: string }>
}): { folded: NativeChatMessage[]; streaming: string | null; data: NativeChatMessage[] } {
  // Fold each tool-result turn into the assistant turn it belongs to.
  const folded = foldToolMessages(stripNoiseMessages(messages))
  // Show the streaming bubble only while its text leads the transcript (shared
  // rule with desktop); once the real turn lands with the same text, drop it.
  const streaming = deriveNativeChatStreamingText({
    messages: folded,
    previewText: streamingText,
    working: agentWorking
  })
  const data: NativeChatMessage[] = [
    ...folded,
    ...(streaming ? [nativeChatStreamingMessage(streaming)] : []),
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
