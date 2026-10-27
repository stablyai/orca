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
import { projectNativeChatTaskListFrames } from '../../../src/shared/native-chat/input/native-chat-task-list-frames'
import { foldSubagentItems } from '../../../src/shared/native-chat-subagent-items'
import { prepareNativeChatMessages } from '../../../src/shared/native-chat-message-preparation'
import {
  isImageRefBlock,
  type AgentType,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import { isImageSourceUserTurn } from '../../../src/shared/native-chat-image-transcript-markers'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'

export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null,
  error?: string
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent ? formatAgentTypeLabel(agent) : 'the agent'
  switch (status) {
    // Missing history may mean new or unreadable; promise neither in the waiting copy.
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

export type MobileNativeChatPendingItem = {
  id: string
  text: string
  images?: string[]
  // Anchor unmatched echoes after their captured tail so later turns cannot reorder them.
  baselineTailMessageId?: string | null
  sentAt?: number
}

export function foldMobileNativeChatMessages(
  messages: readonly NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  // Filter child/noise rows before folding so they cannot split tool runs; project plan updates afterward so they cannot consume another call’s result.
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
  // Keep echoes at their send boundary: some TUIs never record a matching user row, so appending would move them below every later turn.
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
