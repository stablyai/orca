import type { AgentJournalRenderItem } from '../../../src/shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../src/shared/agent-session-journal-item-key'
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
  return {
    id: entry.clientMessageId,
    role: 'user',
    timestamp: entry.queuedAt,
    source: 'transcript',
    blocks: mobilePreviewBlocks(entry.body.blocks, entry.previewUris)
  }
}

function mobilePreviewBlocks(
  blocks: NativeChatMessage['blocks'],
  previewUris: readonly string[]
): NativeChatMessage['blocks'] {
  let imageIndex = 0
  return blocks.map((block) => {
    if (block.type !== 'image-ref') {
      return block
    }
    const preview = previewUris[imageIndex++]
    return preview ? { ...block, url: preview, path: undefined } : block
  })
}

export function buildMobileStructuredTimeline(
  items: readonly AgentJournalRenderItem[],
  outbox: readonly MobileStructuredOutboxEntry[]
): MobileStructuredTimelineRow[] {
  // Why: the host renders its own bubble off the submission WAL row, which lands
  // while the dispatch is still `pending` — before reconciliation retires the echo
  // on `accepted`. Appending both drew the message twice for the whole provider
  // round trip, so adopt the canonical row and keep the entry on it: retry and
  // edit-queued still need the entry while delivery is unconfirmed.
  const adopted = new Map(
    outbox.map((entry) => [agentJournalSubmissionKey(entry.clientMessageId), entry])
  )
  const seen = new Set<string>()
  const canonical = items.flatMap((item): MobileStructuredTimelineRow[] => {
    if (isPendingPrompt(item)) {
      return [{ kind: 'prompt', key: item.itemId, item }]
    }
    const message = projectStructuredItemToNativeChat(item)
    if (!message) {
      return []
    }
    const entry = adopted.get(item.itemId)
    if (entry) {
      seen.add(entry.clientMessageId)
    }
    return [
      {
        kind: 'message',
        key: message.id,
        message: entry
          ? { ...message, blocks: mobilePreviewBlocks(message.blocks, entry.previewUris) }
          : message,
        ...(entry ? { outbox: entry } : {})
      }
    ]
  })
  return [
    ...canonical,
    ...outbox
      .filter((entry) => !seen.has(entry.clientMessageId))
      .map(
        (entry): MobileStructuredTimelineRow => ({
          kind: 'message',
          key: agentJournalSubmissionKey(entry.clientMessageId),
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
