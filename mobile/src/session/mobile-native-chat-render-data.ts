import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import {
  formatNativeChatEmptyStateCopy,
  type NativeChatEmptyStateCopy
} from '../../../src/shared/native-chat-empty-state'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import { foldToolMessages } from './mobile-native-chat-blocks'
import { normalizeImageTranscriptMessages } from './mobile-native-chat-image-transcript-markers'
import { stripNoiseMessages } from './mobile-native-chat-noise'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

/** The centered empty-state copy for a chat with no messages, mirroring the
 *  desktop `NativeChatEmptyState` (shared copy + agent label) so the two surfaces
 *  stay in lockstep. Returns null when the list should stay bare (idle, or the
 *  loading spinner owns the view). */
export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null,
  error?: string
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent ? formatAgentTypeLabel(agent) : 'the agent'
  switch (status) {
    // A live agent with no transcript yet — and a loaded-but-empty transcript —
    // are both "start a chat"; invite the first message instead of implying the
    // agent is still starting up.
    case 'waiting-session':
    case 'ready':
      return formatNativeChatEmptyStateCopy('empty', agentLabel)
    case 'error': {
      const copy = formatNativeChatEmptyStateCopy('error', agentLabel)
      return error ? { ...copy, subtitle: error } : copy
    }
    default:
      return null
  }
}

/** An optimistic user echo: the text and/or the local preview URIs of any images
 *  ridden along on the send, shown until the transcript catches up. */
export type MobileNativeChatPendingItem = {
  id: string
  text: string
  images?: string[]
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
  pending: MobileNativeChatPendingItem[]
}): { folded: NativeChatMessage[]; streaming: string | null; data: NativeChatMessage[] } {
  const folded = foldMobileNativeChatMessages(messages)
  return buildMobileNativeChatTransientData({ folded, streamingText, pending })
}

export function foldMobileNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  // Normalize first (desktop assembler parity): image marker turns fold into
  // image-ref blocks instead of rendering as raw `[Image: …]` text.
  return foldToolMessages(stripNoiseMessages(normalizeImageTranscriptMessages(messages)))
}

export function buildMobileNativeChatTransientData({
  folded,
  streamingText,
  pending
}: {
  folded: NativeChatMessage[]
  streamingText?: string
  pending: MobileNativeChatPendingItem[]
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
      // Text first (when present), then a thumbnail per ridden-along image so the
      // sent photo shows immediately, before the transcript echo lands.
      blocks: [
        ...(p.text ? [{ type: 'text' as const, text: p.text }] : []),
        ...(p.images ?? []).map((uri) => ({ type: 'image-ref' as const, url: uri }))
      ],
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
  // Hide the synthetic bubble only once the real turn has landed leading with the
  // streamed text. A bare length compare would suppress a short new reply behind a
  // longer previous turn; a completed prior turn won't start with the new prefix.
  if (lastText.startsWith(text)) {
    return null
  }
  return text
}
