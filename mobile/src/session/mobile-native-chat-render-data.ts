import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import {
  formatNativeChatEmptyStateCopy,
  type NativeChatEmptyStateCopy
} from '../../../src/shared/native-chat-empty-state'
import { isRootAgentJournalItem } from '../../../src/shared/agent-session-journal-producer'
import { stripNoiseMessages } from '../../../src/shared/native-chat-noise'
import { nativeChatStreamingMessage } from '../../../src/shared/native-chat/native-chat-streaming'
import { isWordlessProviderFrameMessage } from '../../../src/shared/native-chat/native-chat-provider-frame-summary'
import {
  foldToolMessages,
  isUndrawnProviderFrameMessage
} from '../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { projectNativeChatTaskListFrames } from '../../../src/shared/native-chat-task-list-frames'
import { foldSubagentItems } from '../../../src/shared/native-chat-subagent-items'
import { prepareNativeChatMessages } from '../../../src/shared/native-chat-message-preparation'
import {
  isImageRefBlock,
  type AgentType,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import { isImageSourceUserTurn } from '../../../src/shared/native-chat-image-transcript-markers'
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
    // No conversation found yet: the agent has not reported one, or its file is unwritten. That is
    // a new chat or one whose history the host cannot see, so it promises neither.
    case 'waiting-session':
    case 'awaiting-transcript':
      return formatNativeChatEmptyStateCopy('notFound', agentLabel)
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
  /** When it was sent: the echo's time until the transcript row brings its own. */
  sentAt?: number
}

export function foldMobileNativeChatMessages(
  messages: readonly NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  // The conversation only: a subagent's rows are that subagent's, and mobile shows
  // each spawn as its roster row (one line per child) rather than the child's own rows.
  // Prepared as desktop prepares them, so a skill turn and an image marker turn draw as the
  // user's message. An unrecognised event with no words of its own is stored, not drawn, so
  // it goes before folding and never splits a tool run. A Codex plan update draws as its task
  // list, projected after folding as desktop does, so it never takes another call's result; one
  // whose payload cannot be read draws nothing, as on desktop.
  return projectNativeChatTaskListFrames(
    stripNoiseMessages(
      foldToolMessages(
        foldSubagentItems(
          prepareNativeChatMessages(
            messages.filter(
              (message) =>
                isRootAgentJournalItem(message) && !isUndrawnProviderFrameMessage(message)
            ),
            agent
          )
        )
      )
    )
  ).filter((message) => !isWordlessProviderFrameMessage(message))
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
      timestamp: item.sentAt ?? null,
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
    data.push(nativeChatStreamingMessage(streaming))
  }
  data.push(...trailingPending)
  return { folded: renderedFolded, streaming, data }
}
