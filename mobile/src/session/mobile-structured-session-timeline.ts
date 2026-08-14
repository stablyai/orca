import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../src/shared/native-chat-types'
import type { MobileStructuredPromptItem } from './MobileStructuredPromptCard'
import type { PendingNativeChatImage } from './mobile-native-chat-image-attachment'
import type { MobileStructuredOutboxEntry } from './mobile-structured-outbox-store'
import {
  activeStructuredAgentSessionTurnId,
  projectStructuredItemToNativeChat
} from '../../../src/shared/structured-agent-session-projection'

export type MobileStructuredTimelineRow =
  | {
      kind: 'message'
      key: string
      message: NativeChatMessage
      outbox?: MobileStructuredOutboxEntry
    }
  | { kind: 'prompt'; key: string; item: MobileStructuredPromptItem }

function isPendingPrompt(item: AgentJournalRenderItem): item is MobileStructuredPromptItem {
  const body = item.body
  return (
    (body.kind === 'approval' || body.kind === 'question') && body.resolution.state === 'pending'
  )
}

function outboxMessage(entry: MobileStructuredOutboxEntry): NativeChatMessage {
  let imageIndex = 0
  return {
    id: entry.clientMessageId,
    role: 'user',
    timestamp: entry.queuedAt,
    source: 'transcript',
    blocks: entry.body.blocks.map((block) => {
      if (block.type !== 'image-ref') {
        return block
      }
      const preview = entry.previewUris[imageIndex++]
      return preview ? { ...block, url: preview, path: undefined } : block
    })
  }
}

export function buildMobileStructuredTimeline(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly MobileStructuredOutboxEntry[]
): MobileStructuredTimelineRow[] {
  const canonical = items.flatMap((item): MobileStructuredTimelineRow[] => {
    if (isPendingPrompt(item)) {
      return [{ kind: 'prompt', key: item.itemId, item }]
    }
    const message = projectStructuredItemToNativeChat(item)
    return message ? [{ kind: 'message', key: message.id, message }] : []
  })
  return [
    ...canonical,
    ...outbox.map(
      (entry): MobileStructuredTimelineRow => ({
        kind: 'message',
        key: entry.clientMessageId,
        message: outboxMessage(entry),
        outbox: entry
      })
    )
  ]
}

export function activeMobileStructuredTurnId(
  items: readonly AgentJournalRenderItem[]
): string | null {
  return activeStructuredAgentSessionTurnId(items)
}

export function mobileStructuredOutboxText(entry: MobileStructuredOutboxEntry): string {
  return entry.body.blocks
    .flatMap((block) => (block.type === 'text' ? [block.text] : []))
    .join('\n')
}

export function restoreMobileStructuredAttachments(
  entry: MobileStructuredOutboxEntry
): PendingNativeChatImage[] {
  let imageIndex = 0
  return entry.body.blocks.flatMap((block) => {
    if (block.type !== 'image-ref' || !block.path) {
      return []
    }
    const index = imageIndex++
    return [
      {
        id: `restored:${entry.clientMessageId}:${index}`,
        path: block.path,
        previewUri: entry.previewUris[index] ?? block.path
      }
    ]
  })
}
