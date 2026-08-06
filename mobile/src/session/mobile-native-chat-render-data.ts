import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import type { NativeChatEmptyStateCopy } from '../../../src/shared/native-chat-empty-state'
import { isImageRefBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import { foldToolMessages } from './mobile-native-chat-blocks'
import { normalizeImageTranscriptMessages } from './mobile-native-chat-image-transcript-markers'
import { stripNoiseMessages } from './mobile-native-chat-noise'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import { t } from '@/i18n/mobile-i18n'

/** The centered empty-state copy for a chat with no messages, mirroring the
 *  desktop `NativeChatEmptyState` (shared copy + agent label) so the two surfaces
 *  stay in lockstep. Returns null when the list should stay bare (idle, or the
 *  loading spinner owns the view). */
export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null,
  error?: string
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent ? formatAgentTypeLabel(agent) : t('mobileNativeChatRenderData.agent')
  switch (status) {
    // A live agent with no transcript yet — and a loaded-but-empty transcript —
    // are both "start a chat"; invite the first message instead of implying the
    // agent is still starting up.
    case 'waiting-session':
    case 'ready':
      return {
        title: t('nativeChat.empty.title', { agentLabel }),
        subtitle: t('nativeChat.empty.subtitle', { agentLabel })
      }
    case 'error': {
      return {
        title: t('nativeChat.error.title'),
        subtitle: error || t('nativeChat.error.subtitle')
      }
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

export function foldMobileNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  // Normalize first (desktop assembler parity): image marker turns fold into
  // image-ref blocks instead of rendering as raw `[Image: …]` text.
  return foldToolMessages(stripNoiseMessages(normalizeImageTranscriptMessages(messages)))
}

/** Assemble the list data the chat renders: the folded transcript, then a
 *  synthetic bubble for the streaming text the gate let through, then the
 *  route-owned optimistic "queued" messages at the tail. */
export function buildMobileNativeChatTransientData({
  folded,
  streaming,
  pending,
  imagePreviewsByMessageId
}: {
  folded: NativeChatMessage[]
  /** Streaming bubble text, already gated by `deriveMobileNativeChatStreaming`. */
  streaming: string | null
  pending: MobileNativeChatPendingItem[]
  imagePreviewsByMessageId?: Record<string, string[]>
}): { folded: NativeChatMessage[]; streaming: string | null; data: NativeChatMessage[] } {
  const renderedFolded = folded.map((message) => {
    const previews = imagePreviewsByMessageId?.[message.id]
    if (message.role !== 'user' || !previews?.length) {
      return message
    }
    let previewIndex = 0
    const blocks = message.blocks.map((block) => {
      if (!isImageRefBlock(block)) {
        return block
      }
      const url = previews[previewIndex]
      previewIndex += 1
      return url ? { ...block, url } : block
    })
    while (previewIndex < previews.length) {
      blocks.push({ type: 'image-ref', url: previews[previewIndex] })
      previewIndex += 1
    }
    return { ...message, blocks }
  })
  const data: NativeChatMessage[] = [
    ...renderedFolded,
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
  return { folded: renderedFolded, streaming, data }
}
