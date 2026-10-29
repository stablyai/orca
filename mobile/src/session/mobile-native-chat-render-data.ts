import { formatAgentTypeLabel } from '../../../src/shared/agent-type-label'
import type { NativeChatEmptyStateCopy } from '../../../src/shared/native-chat/native-chat-empty-state'
import { isRootAgentJournalItem } from '../../../src/shared/agent-session-journal-producer'
import { stripNoiseMessages } from '../../../src/shared/native-chat-noise'
import { nativeChatStreamingMessage } from '../../../src/shared/native-chat/native-chat-streaming'
import { isWordlessProviderFrameMessage } from '../../../src/shared/native-chat/native-chat-provider-frame-summary'
import {
  foldToolMessages,
  isUndrawnProviderFrameMessage
} from '../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { projectNativeChatTaskListFrames } from '../../../src/shared/native-chat/input/native-chat-task-list-frames'
import { foldSubagentItems } from '../../../src/shared/native-chat/transcript/native-chat-subagent-items'
import { prepareNativeChatMessages } from '../../../src/shared/native-chat/transcript/native-chat-message-preparation'
import {
  isImageRefBlock,
  type AgentType,
  type NativeChatMessage
} from '../../../src/shared/native-chat-types'
import type { MobileNativeChatStatus } from './use-mobile-native-chat-session'
import { translate } from '../i18n/mobile-i18n'

function mobileNativeChatEmptyStateCopy(
  kind: 'notFound' | 'empty' | 'error',
  agentLabel: string
): NativeChatEmptyStateCopy {
  switch (kind) {
    case 'notFound':
      return {
        title: translate(
          'session.nativeChatRenderData.notFoundTitle',
          "Can't find this conversation yet"
        ),
        subtitle: translate(
          'session.nativeChatRenderData.notFoundSubtitle',
          'Send a message to start one, or open the terminal view to see what {{agent}} is doing.',
          { agent: agentLabel }
        )
      }
    case 'empty':
      return {
        title: translate('session.nativeChatRenderData.emptyTitle', 'Start a chat with {{agent}}', {
          agent: agentLabel
        }),
        subtitle: translate(
          'session.nativeChatRenderData.emptySubtitle',
          'Ask {{agent}} to inspect code, explain output, or make a change.',
          { agent: agentLabel }
        )
      }
    case 'error':
      return {
        title: translate('session.nativeChatRenderData.errorTitle', 'Could not load conversation'),
        subtitle: translate(
          'session.nativeChatRenderData.errorSubtitle',
          'The transcript could not be read. Toggle back to the terminal to keep working.'
        )
      }
  }
}

export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null,
  error?: string,
  sessionLive = false
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent
    ? formatAgentTypeLabel(agent)
    : translate('session.nativeChatRenderData.defaultAgentLabel', 'the agent')
  switch (status) {
    // Missing history may mean new or unreadable; promise neither in the waiting copy.
    case 'waiting-session':
      return mobileNativeChatEmptyStateCopy('notFound', agentLabel)
    // A session the running agent just reported has no file until its first prompt.
    case 'awaiting-transcript':
      return mobileNativeChatEmptyStateCopy(sessionLive ? 'empty' : 'notFound', agentLabel)
    case 'ready':
      return mobileNativeChatEmptyStateCopy('empty', agentLabel)
    case 'error': {
      const copy = mobileNativeChatEmptyStateCopy('error', agentLabel)
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
