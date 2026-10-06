import {
  nativeChatMessagesShareTranscriptRow,
  nativeChatSemanticRowId,
  type NativeChatMessage
} from '../../../../shared/native-chat-types'
import { agentSessionHostStatusBody } from '../../../../shared/agent-session-host-status-rows'
import { boundJournalKeyComponent } from '../../../../shared/agent-session-journal-item-key'
import { HISTORY_PAGE_CONTENT_BUDGET_BYTES } from '../../../native-chat/agent-session-wire/agent-session-history-page-bounds'

function oversizedRow(message: NativeChatMessage): NativeChatMessage {
  const { text, presentation } = agentSessionHostStatusBody('history-item-too-large')
  return {
    id: boundJournalKeyComponent(nativeChatSemanticRowId(message)),
    role: 'system',
    blocks: [{ type: 'text', text, presentation }],
    timestamp: message.timestamp,
    source: message.source,
    ...(message.transcriptOffset !== undefined
      ? { transcriptOffset: message.transcriptOffset }
      : {})
  }
}

function groupBytes(group: readonly NativeChatMessage[]): number {
  return group.reduce((bytes, message) => bytes + Buffer.byteLength(JSON.stringify(message)) + 1, 0)
}

function rowGroups(messages: readonly NativeChatMessage[]): NativeChatMessage[][] {
  const groups: NativeChatMessage[][] = []
  for (const message of messages) {
    const last = groups.at(-1)
    if (last && nativeChatMessagesShareTranscriptRow(last.at(-1)!, message)) {
      last.push(message)
    } else {
      groups.push([message])
    }
  }
  return groups
}

export function boundNativeChatRpcPageByBytes(
  messages: readonly NativeChatMessage[],
  hasMore: boolean,
  beforeOffset: number
): { messages: NativeChatMessage[]; hasMore: boolean; beforeOffset: number } {
  const groups = rowGroups(messages)
  const kept: NativeChatMessage[][] = []
  let bytes = 2
  let retained = 0
  for (const group of groups.toReversed()) {
    const size = groupBytes(group)
    if (kept.length === 0 && size > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
      kept.push([oversizedRow(group[0])])
      retained += group.length
      break
    }
    if (bytes + size > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
      break
    }
    kept.push(group)
    retained += group.length
    bytes += size
  }
  const selected = kept.toReversed().flat()
  const dropped = retained < messages.length
  const cursor = selected[0]?.transcriptOffset
  // A legacy projection has no row cursor: explicitly omit the page rather than skip unseen history.
  if (dropped && cursor === undefined) {
    return { messages: messages.length ? [oversizedRow(messages[0])] : [], hasMore, beforeOffset }
  }
  return {
    messages: selected,
    hasMore: hasMore || dropped,
    beforeOffset: dropped ? (cursor ?? beforeOffset) : beforeOffset
  }
}

export function nativeChatRpcAppendBatches(
  messages: readonly NativeChatMessage[]
): NativeChatMessage[][] {
  const batches: NativeChatMessage[][] = []
  let batch: NativeChatMessage[] = []
  let bytes = 2
  for (const group of rowGroups(messages)) {
    const bounded =
      groupBytes(group) > HISTORY_PAGE_CONTENT_BUDGET_BYTES ? [oversizedRow(group[0])] : group
    const size = groupBytes(bounded)
    if (batch.length > 0 && bytes + size > HISTORY_PAGE_CONTENT_BUDGET_BYTES) {
      batches.push(batch)
      batch = []
      bytes = 2
    }
    batch.push(...bounded)
    bytes += size
  }
  if (batch.length > 0) {
    batches.push(batch)
  }
  return batches
}
