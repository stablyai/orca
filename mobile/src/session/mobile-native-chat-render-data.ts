import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import {
  formatNativeChatEmptyStateCopy,
  type NativeChatEmptyStateCopy
} from '../../../src/shared/native-chat-empty-state'
import { stripNoiseMessages } from '../../../src/shared/native-chat-noise'
import { foldToolMessages } from '../../../src/shared/native-chat-tool-fold'
import { isImageRefBlock, type NativeChatMessage } from '../../../src/shared/native-chat-types'
import {
  isImageSourceUserTurn,
  normalizeImageTranscriptMessages
} from './mobile-native-chat-image-transcript-markers'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

/** The centered empty-state copy for a chat with no messages, mirroring the
 *  desktop `NativeChatEmptyState` (shared copy + agent label) so the two surfaces
 *  stay in lockstep. Returns null when the list should stay bare (idle, or the
 *  loading spinner owns the view).
 *
 *  Why three distinct copies: these statuses used to share the `empty` copy, so a
 *  pane that could not address its transcript at all read exactly like a blank new
 *  chat — "Start a chat with Claude" over a footer saying "Agent is working". Each
 *  status now states which of the three it is, so a bug is separable from a blank
 *  slate without reading logs. */
export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null,
  error?: string,
  agentWorking = false
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent ? formatAgentTypeLabel(agent) : 'the agent'
  switch (status) {
    // No session id: the transcript has no address, so nothing was ever read.
    case 'waiting-session':
      return formatNativeChatEmptyStateCopy('waitingSession', agentLabel)
    // Addressed, but the transcript file does not exist on the host yet.
    case 'awaiting-transcript':
      return formatNativeChatEmptyStateCopy('awaitingTranscript', agentLabel)
    // Read settled and really is empty. Only then is "start a chat" true — and
    // only while the agent is not mid-turn.
    case 'ready':
      return formatNativeChatEmptyStateCopy(agentWorking ? 'workingEmpty' : 'empty', agentLabel)
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
  /** Transcript tail when the send was issued. The echo renders directly after
   *  that row, so a send whose row never arrives stays where it was sent instead
   *  of trailing every turn that lands afterwards. */
  baselineTailMessageId?: string | null
}

export function foldMobileNativeChatMessages(messages: NativeChatMessage[]): NativeChatMessage[] {
  // Normalize first (desktop assembler parity): image marker turns fold into
  // image-ref blocks instead of rendering as raw `[Image: …]` text.
  return stripNoiseMessages(foldToolMessages(normalizeImageTranscriptMessages(messages)))
}

/** Assemble the folded transcript, streaming text, and optimistic user echoes. */
export function buildMobileNativeChatTransientData({
  messages,
  folded,
  streaming,
  pending,
  imagePreviewsByMessageId
}: {
  /** Raw transcript rows, used to project folded-away send boundaries. */
  messages: NativeChatMessage[]
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
  // Why anchored rather than appended: an echo whose transcript row never
  // arrives — Claude consumes a mid-turn send without writing a user record —
  // used to sit at the tail forever, re-reading below every turn that landed
  // afterwards. That is what makes the conversation look re-ordered. Rendering it
  // after the row it was sent against keeps it in place, so an unmatched echo is
  // at worst a duplicate in the right position instead of a scrambled one.
  const anchoredPending = new Map<string, NativeChatMessage[]>()
  const leadingPending: NativeChatMessage[] = []
  const trailingPending: NativeChatMessage[] = []
  const foldedIds = new Set(renderedFolded.map((message) => message.id))
  const missingBaselineIds = new Set<string>()
  for (const item of pending) {
    const baselineId = item.baselineTailMessageId
    if (baselineId && !foldedIds.has(baselineId)) {
      missingBaselineIds.add(baselineId)
    }
  }
  const foldedAnchorByRawId = new Map<string, string>()
  const leadingBaselineIds = new Set<string>()
  if (missingBaselineIds.size > 0) {
    let lastVisibleId: string | null = null
    const forwardImageBaselineIds: string[] = []
    for (const message of messages) {
      if (foldedIds.has(message.id)) {
        for (const baselineId of forwardImageBaselineIds) {
          foldedAnchorByRawId.set(baselineId, message.id)
        }
        forwardImageBaselineIds.length = 0
        lastVisibleId = message.id
      }
      if (!missingBaselineIds.has(message.id)) {
        continue
      }
      if (isImageSourceUserTurn(message)) {
        forwardImageBaselineIds.push(message.id)
      } else if (lastVisibleId) {
        foldedAnchorByRawId.set(message.id, lastVisibleId)
      } else {
        leadingBaselineIds.add(message.id)
      }
    }
  }
  for (const item of pending) {
    const bubble: NativeChatMessage = {
      id: item.id,
      role: 'user',
      // Text first (when present), then a thumbnail per ridden-along image so the
      // sent photo shows immediately, before the transcript echo lands.
      blocks: [
        ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
        ...(item.images ?? []).map((uri) => ({ type: 'image-ref' as const, url: uri }))
      ],
      timestamp: null,
      source: 'transcript'
    }
    // Tool/noise rows fold backward; image-source rows fold into their following prompt.
    const baselineId = item.baselineTailMessageId
    if (baselineId && leadingBaselineIds.has(baselineId)) {
      leadingPending.push(bubble)
      continue
    }
    const anchor = baselineId
      ? foldedIds.has(baselineId)
        ? baselineId
        : foldedAnchorByRawId.get(baselineId)
      : undefined
    if (!anchor || !foldedIds.has(anchor)) {
      trailingPending.push(bubble)
      continue
    }
    const siblings = anchoredPending.get(anchor)
    if (siblings) {
      siblings.push(bubble)
    } else {
      anchoredPending.set(anchor, [bubble])
    }
  }

  const data: NativeChatMessage[] = [...leadingPending]
  for (const message of renderedFolded) {
    data.push(message)
    const attached = anchoredPending.get(message.id)
    if (attached) {
      data.push(...attached)
    }
  }
  if (streaming) {
    data.push({
      id: 'streaming',
      role: 'assistant',
      blocks: [{ type: 'text', text: streaming }],
      timestamp: null,
      source: 'hook'
    })
  }
  data.push(...trailingPending)
  return { folded: renderedFolded, streaming, data }
}
