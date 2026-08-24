import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import {
  formatNativeChatEmptyStateCopy,
  type NativeChatEmptyStateCopy
} from '../../../src/shared/native-chat-empty-state'
import { stripNoiseMessages } from '../../../src/shared/native-chat-noise'
import { foldToolMessages } from '../../../src/shared/native-chat-tool-fold'
import { isImageRefBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import { normalizeImageTranscriptMessages } from './mobile-native-chat-image-transcript-markers'
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
  /** True when the agent was already replying at send time, so this prompt is
   *  queued behind the in-flight turn and belongs after the streaming bubble. */
  queuedWhileWorking?: boolean
}

export function foldMobileNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  // Normalize first (desktop assembler parity): image marker turns fold into
  // image-ref blocks instead of rendering as raw `[Image: …]` text.
  return foldToolMessages(stripNoiseMessages(normalizeImageTranscriptMessages(messages)))
}

/** Assemble the list data the chat renders: the folded transcript, then a
 *  synthetic bubble for the streaming text the gate let through, then the
 *  route-owned accepted optimistic messages at the tail. */
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
  const echoMessage = (p: MobileNativeChatPendingItem): NativeChatMessage => ({
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
  })
  // The streaming bubble splits the echoes rather than preceding all of them: a
  // prompt sent while the agent was idle is what this reply is answering, so the
  // reply belongs BELOW it. Only a prompt queued mid-reply sits after the bubble.
  // Emitting every echo last put the reply above the message that caused it, which
  // read as the sent message being stuck at the bottom of the transcript.
  const data: NativeChatMessage[] = [
    ...renderedFolded,
    ...pending.filter((p) => !p.queuedWhileWorking).map(echoMessage),
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
    ...pending.filter((p) => p.queuedWhileWorking).map(echoMessage)
  ]
  return { folded: renderedFolded, streaming, data }
}
