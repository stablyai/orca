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
import { nativeChatMessageText } from './mobile-native-chat-message-text'
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
    // A live agent with no transcript yet — an unwritten transcript file, or a
    // loaded-but-empty one — is "start a chat"; invite the first message instead
    // of implying the agent is still starting up.
    case 'waiting-session':
    case 'awaiting-transcript':
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

/** One navigable turn in the conversation outline: a user prompt and, when the
 *  agent has replied, a snippet of that turn's final assistant text. `index` is
 *  the position in the assembled `data` list, which is exactly what
 *  `FlatList.scrollToIndex` addresses (the "Load earlier" header is separate). */
export type MobileNativeChatOutlineItem = {
  index: number
  title: string
  subtitle?: string
}

const OUTLINE_TITLE_MAX_LENGTH = 80
const OUTLINE_SUBTITLE_MAX_LENGTH = 120

function compactOutlineLine(text: string, maxLength: number): string {
  // First non-blank line only: a long paste's later lines add noise, not a label.
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? ''
  const compact = firstLine.replace(/\s+/g, ' ').trim()
  if (compact.length <= maxLength) {
    return compact
  }
  return `${compact.slice(0, maxLength - 1).trimEnd()}…`
}

/** The trailing assistant prose of the turn a user row opens: scan forward to the
 *  next user row, keeping the last non-empty assistant text (mirrors t3's
 *  `resolveFinalAssistantTextForTurn`). */
function resolveOutlineTurnReply(data: NativeChatMessage[], userIndex: number): string {
  let reply = ''
  for (let index = userIndex + 1; index < data.length; index += 1) {
    const message = data[index]
    if (message.role === 'user') {
      break
    }
    if (message.role === 'assistant') {
      const text = nativeChatMessageText(message.blocks)
      if (text) {
        reply = text
      }
    }
  }
  return reply
}

/** Build the turn-jump outline: one entry per user turn in `data`, so tapping an
 *  entry scrolls the list straight to that prompt. Pure — the view memoizes it. */
export function deriveMobileNativeChatOutline(
  data: NativeChatMessage[]
): MobileNativeChatOutlineItem[] {
  const items: MobileNativeChatOutlineItem[] = []
  for (let index = 0; index < data.length; index += 1) {
    const message = data[index]
    if (message.role !== 'user') {
      continue
    }
    const prose = compactOutlineLine(nativeChatMessageText(message.blocks), OUTLINE_TITLE_MAX_LENGTH)
    // An image-only send has no prose; still list it so the turn stays reachable.
    const title = prose || (message.blocks.some(isImageRefBlock) ? 'Image' : '')
    if (!title) {
      continue
    }
    const subtitle = compactOutlineLine(
      resolveOutlineTurnReply(data, index),
      OUTLINE_SUBTITLE_MAX_LENGTH
    )
    items.push(subtitle ? { index, title, subtitle } : { index, title })
  }
  return items
}
