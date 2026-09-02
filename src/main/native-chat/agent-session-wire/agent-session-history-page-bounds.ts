import {
  agentJournalSubmissionKey,
  boundJournalKeyComponent
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'

export const AGENT_SESSION_HISTORY_MAX_PAGE_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2

const HISTORY_PAGE_ENVELOPE_RESERVE_BYTES = 64 * 1024

export const HISTORY_PAGE_CONTENT_BUDGET_BYTES =
  AGENT_SESSION_HISTORY_MAX_PAGE_BYTES - HISTORY_PAGE_ENVELOPE_RESERVE_BYTES

export function historyEntryBytes(
  item: AgentJournalRenderItem,
  submissionBytes: ReadonlyMap<string, number>
): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8') + (submissionBytes.get(item.itemId) ?? 0)
}

export function submissionBytesByItemId(
  submissions: readonly AgentJournalSubmission[]
): Map<string, number> {
  return new Map(
    submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      Buffer.byteLength(JSON.stringify(submission), 'utf8')
    ])
  )
}

export function oversizedHistoryItem(
  item: AgentJournalRenderItem,
  byteLength: number
): AgentJournalRenderItem {
  return {
    ...item,
    itemId: boundJournalKeyComponent(item.itemId),
    body: {
      kind: 'status',
      text: `[Orca: item truncated — ${byteLength} bytes exceeds the history page budget]`
    }
  }
}

export function boundHistoryItemsByBytes(
  items: AgentJournalRenderItem[],
  keep: 'newest' | 'oldest',
  submissionBytes: ReadonlyMap<string, number>,
  maxBytes: number
): { items: AgentJournalRenderItem[]; dropped: number } {
  const groups = groupItemsBySequence(items)
  const ordered = keep === 'newest' ? groups.toReversed() : groups
  const kept: AgentJournalRenderItem[][] = []
  let total = 0
  for (const group of ordered) {
    const bytes = group.reduce((sum, item) => sum + historyEntryBytes(item, submissionBytes), 0)
    if (kept.length === 0 && bytes > maxBytes) {
      kept.push(group.map((item) => oversizedHistoryItem(item, bytes)))
      break
    }
    if (total + bytes > maxBytes) {
      break
    }
    kept.push(group)
    total += bytes
  }
  return {
    items: (keep === 'newest' ? kept.toReversed() : kept).flat(),
    dropped: items.length - kept.reduce((count, group) => count + group.length, 0)
  }
}

function groupItemsBySequence(
  items: readonly AgentJournalRenderItem[]
): AgentJournalRenderItem[][] {
  const groups: AgentJournalRenderItem[][] = []
  for (const item of items) {
    const current = groups.at(-1)
    if (current?.[0]?.sequence === item.sequence) {
      current.push(item)
    } else {
      groups.push([item])
    }
  }
  return groups
}

export function newestWholeSequenceGroups(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const groups = groupItemsBySequence(items)
  const selected: AgentJournalRenderItem[][] = []
  let count = 0
  for (const group of groups.toReversed()) {
    if (selected.length > 0 && count + group.length > limit) {
      break
    }
    selected.push(group)
    count += group.length
  }
  return selected.toReversed().flat()
}
