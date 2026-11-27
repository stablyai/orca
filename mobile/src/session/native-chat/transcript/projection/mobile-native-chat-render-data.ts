import { foldAutomationRunCards } from '../../../../../../src/shared/native-chat/transcript/native-chat-transcript-projection'
import { formatAgentTypeLabel } from '../../../../../../src/shared/agent-status/presentation/agent-type-label'
import { describeLoadError } from '../../../../components/feedback/load-error-description'
import type { NativeChatEmptyStateCopy } from '../../../../../../src/shared/native-chat/native-chat-empty-state'
import { isRootAgentJournalItem } from '../../../../../../src/shared/agent-session/journal/agent-session-journal-producer'
import { stripNoiseMessages } from '../../../../../../src/shared/native-chat/transcript/messages/native-chat-noise'
import { nativeChatStreamingMessage } from '../../../../../../src/shared/native-chat/transcript/streaming/native-chat-streaming'
import { isWordlessProviderFrameMessage } from '../../../../../../src/shared/native-chat/transcript/notices/native-chat-provider-frame-summary'
import {
  foldToolMessages,
  isUndrawnProviderFrameMessage
} from '../../../../../../src/shared/native-chat/tools/native-chat-tool-fold'
import { projectNativeChatTaskListFrames } from '../../../../../../src/shared/native-chat/input/task-lists/native-chat-task-list-frames'
import { foldSubagentItems } from '../../../../../../src/shared/native-chat/transcript/subagents/native-chat-subagent-items'
import { prepareNativeChatMessages } from '../../../../../../src/shared/native-chat/transcript/messages/native-chat-message-preparation'
import {
  isImageRefBlock,
  type NativeChatMessage
} from '../../../../../../src/shared/native-chat/native-chat-types'
import type { AgentType } from '../../../../../../src/shared/agent-status/contracts/agent-status-types'
import type { MobileNativeChatStatus } from '../../status/mobile-native-chat-session-status'
import { orderNativeChatDisplayMessages } from '../../../../../../src/shared/native-chat/transcript/messages/native-chat-message-order'
import type { Translate } from '../../../../i18n/mobile-i18n'

function mobileNativeChatEmptyStateCopy(
  kind: 'notFound' | 'empty' | 'error',
  agentLabel: string,
  t: Translate
): NativeChatEmptyStateCopy {
  switch (kind) {
    case 'notFound':
      return {
        title: t('session.nativeChatRenderData.notFoundTitle', "Can't find this conversation yet"),
        subtitle: t('session.nativeChatRenderData.notFoundMessage', 'Send a message to start one.')
      }
    case 'empty':
      return {
        title: t('session.nativeChatRenderData.emptyTitle', 'Start a chat with {{agent}}', {
          agent: agentLabel
        }),
        // The composer is right there; the title is enough.
        subtitle: ''
      }
    case 'error':
      return {
        title: t('session.nativeChatRenderData.errorTitle', 'Could not load conversation'),
        subtitle: t(
          'session.nativeChatRenderData.errorMessage',
          'The conversation couldn’t be read. The terminal view still works.'
        )
      }
  }
}

export function mobileNativeChatEmptyState(
  status: MobileNativeChatStatus,
  agent: string | null | undefined,
  t: Translate,
  error?: string,
  sessionLive = false,
  /** A sent /clear hid the old rows: a blank list until its divider lands, not new-chat copy. */
  clearing = false
): NativeChatEmptyStateCopy | null {
  const agentLabel = agent
    ? formatAgentTypeLabel(agent)
    : t('session.nativeChatRenderData.defaultAgentLabel', 'the agent')
  if (
    agent === 'hermes' &&
    (status === 'waiting-session' || (status === 'awaiting-transcript' && !sessionLive))
  ) {
    return {
      title: t('session.nativeChatRenderData.hermesStartingTitle', 'Connecting to Hermes…'),
      subtitle: t(
        'session.nativeChatRenderData.hermesStartingSubtitle',
        'The conversation will appear when Hermes is ready.'
      )
    }
  }
  switch (status) {
    // Missing history may mean new or unreadable; promise neither in the waiting copy.
    case 'waiting-session':
      return mobileNativeChatEmptyStateCopy('notFound', agentLabel, t)
    // A session the running agent just reported has no file until its first prompt.
    case 'awaiting-transcript':
      return mobileNativeChatEmptyStateCopy(sessionLive ? 'empty' : 'notFound', agentLabel, t)
    case 'ready':
      return clearing ? null : mobileNativeChatEmptyStateCopy('empty', agentLabel, t)
    case 'error': {
      const copy = mobileNativeChatEmptyStateCopy('error', agentLabel, t)
      return error ? { ...copy, subtitle: describeLoadError(error, t).message } : copy
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
  pendingSend?: NativeChatMessage['pendingSend']
}

export function foldMobileNativeChatMessages(
  messages: readonly NativeChatMessage[],
  agent: AgentType
): NativeChatMessage[] {
  return foldAutomationRunCards(
    finishMobileNativeChatMessages(
      foldToolMessages(foldSubagentItems(prepareMobileNativeChatMessages(messages, agent)))
    )
  )
}

export function isMobileNativeChatSource(message: NativeChatMessage): boolean {
  return isRootAgentJournalItem(message) && !isUndrawnProviderFrameMessage(message)
}

export function prepareMobileNativeChatMessages(
  messages: readonly NativeChatMessage[],
  agent: AgentType,
  recordSource?: (message: NativeChatMessage, visible: boolean) => void
): NativeChatMessage[] {
  return prepareNativeChatMessages(
    messages.filter((message) => {
      const visible = isMobileNativeChatSource(message)
      recordSource?.(message, visible)
      return visible
    }),
    agent
  )
}

export function finishMobileNativeChatMessages(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[] {
  // Plan frames must not consume another call's result.
  return projectNativeChatTaskListFrames(stripNoiseMessages(messages)).filter(
    (message) => !isWordlessProviderFrameMessage(message)
  )
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
  const transient: NativeChatMessage[] = []
  if (streaming) {
    transient.push(nativeChatStreamingMessage(streaming))
  }
  for (const item of pending) {
    transient.push({
      id: item.id,
      role: 'user',
      blocks: [
        ...(item.text ? [{ type: 'text' as const, text: item.text }] : []),
        ...(item.images ?? []).map((uri) => ({ type: 'image-ref' as const, url: uri }))
      ],
      timestamp: item.sentAt ?? null,
      pendingSend: item.pendingSend ?? 'active',
      source: 'transcript'
    })
  }
  return {
    folded: renderedFolded,
    streaming,
    data: [...renderedFolded, ...orderNativeChatDisplayMessages(transient)]
  }
}
