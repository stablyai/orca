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
  folded,
  streaming,
  pending,
  imagePreviewsByMessageId
}: {
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
  // Desktop order: transcript rows, then the streaming preview, then unmatched echoes in send order.
  const data: NativeChatMessage[] = [...renderedFolded]
  if (streaming) {
    data.push(nativeChatStreamingMessage(streaming))
  }
  for (const item of pending) {
    data.push({
      id: item.id,
      role: 'user',
      blocks: [
        ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
        ...(item.images ?? []).map((uri) => ({ type: 'image-ref' as const, url: uri }))
      ],
      timestamp: item.sentAt ?? null,
      source: 'transcript'
    })
  }
  return { folded: renderedFolded, streaming, data }
}
