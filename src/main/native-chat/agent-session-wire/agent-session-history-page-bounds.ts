import { isRootAgentJournalItem } from '../../../shared/agent-session-journal-producer'
import { isSubagentBlock } from '../../../shared/native-chat-types'
import {
  agentJournalSubmissionKey,
  boundJournalKeyComponent
} from '../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime-memory-limits'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { agentSessionHostStatusBody } from '../../../shared/agent-session-host-status-rows'
import { subagentFoldKey, subagentItemBlock } from '../../../shared/native-chat-subagent-items'

export const AGENT_SESSION_HISTORY_MAX_PAGE_BYTES = REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES / 2

const HISTORY_PAGE_ENVELOPE_RESERVE_BYTES = 64 * 1024

export const HISTORY_PAGE_CONTENT_BUDGET_BYTES =
  AGENT_SESSION_HISTORY_MAX_PAGE_BYTES - HISTORY_PAGE_ENVELOPE_RESERVE_BYTES

/** Reserve bridge/envelope metadata separately from row content. */
const FRAME_METADATA_CEILING_BYTES = 64 * 1024

export const BOUNDED_FRAME_CONTENT_BUDGET_BYTES =
  MOBILE_BRIDGE_MAX_FRAME_BYTES - FRAME_METADATA_CEILING_BYTES

export function historyEntryBytes(
  item: AgentJournalRenderItem,
  submissionBytes: ReadonlyMap<string, number>
): number {
  return Buffer.byteLength(JSON.stringify(item), 'utf8') + (submissionBytes.get(item.itemId) ?? 0)
}

// Snapshot arrays change with submissions, so cache serialization once per paged snapshot.
const bytesBySubmissions = new WeakMap<
  readonly AgentJournalSubmission[],
  ReadonlyMap<string, number>
>()

export function submissionBytesByItemId(
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, number> {
  const cached = bytesBySubmissions.get(submissions)
  if (cached) {
    return cached
  }
  const bytes = new Map(
    submissions.map((submission) => [
      agentJournalSubmissionKey(submission.clientMessageId),
      Buffer.byteLength(JSON.stringify(submission), 'utf8')
    ])
  )
  bytesBySubmissions.set(submissions, bytes)
  return bytes
}

export function oversizedHistoryItem(item: AgentJournalRenderItem): AgentJournalRenderItem {
  return {
    ...item,
    itemId: boundJournalKeyComponent(item.itemId),
    body: agentSessionHostStatusBody('history-item-too-large')
  }
}

export type HistoryItemForm = {
  item: AgentJournalRenderItem
  bytes: number
}

export function measureHistoryItem(item: AgentJournalRenderItem): HistoryItemForm {
  return { item, bytes: Buffer.byteLength(JSON.stringify(item), 'utf8') }
}

/** Measure pages in the exact form sent to each reader. */
export type HistoryReader = {
  form: (item: AgentJournalRenderItem) => HistoryItemForm
  budgetBytes: number
}

export function boundHistoryItemsByBytes(
  items: AgentJournalRenderItem[],
  keep: 'newest' | 'oldest',
  submissionBytes: ReadonlyMap<string, number>,
  maxBytes: number,
  form: HistoryReader['form'] = measureHistoryItem
): { items: AgentJournalRenderItem[]; dropped: number } {
  const ordered = groupItemsBySequence(items, keep)
  const kept: AgentJournalRenderItem[][] = []
  let total = 0
  for (const stored of ordered) {
    const formed = stored.map(form)
    const group = formed.map(({ item }) => item)
    const bytes = formed.reduce(
      (sum, { item, bytes }) => sum + bytes + (submissionBytes.get(item.itemId) ?? 0),
      0
    )
    if (kept.length === 0 && bytes > maxBytes) {
      kept.push(group.map((item) => oversizedHistoryItem(item)))
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

/** Group only visited adjacent sequence runs, preserving item order in either traversal direction. */
function* groupItemsBySequence(
  items: readonly AgentJournalRenderItem[],
  keep: 'newest' | 'oldest'
): Generator<AgentJournalRenderItem[]> {
  let cursor = keep === 'newest' ? items.length : 0
  while (keep === 'newest' ? cursor > 0 : cursor < items.length) {
    if (keep === 'newest') {
      let start = cursor - 1
      const sequence = items[start].sequence
      while (start > 0 && items[start - 1].sequence === sequence) {
        start -= 1
      }
      yield items.slice(start, cursor)
      cursor = start
    } else {
      let end = cursor + 1
      const sequence = items[cursor].sequence
      while (end < items.length && items[end].sequence === sequence) {
        end += 1
      }
      yield items.slice(cursor, end)
      cursor = end
    }
  }
}

export function newestWholeSequenceGroups(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const selected: AgentJournalRenderItem[][] = []
  let count = 0
  for (const group of groupItemsBySequence(items, 'newest')) {
    if (selected.length > 0 && count + group.length > limit) {
      break
    }
    selected.push(group)
    count += group.length
  }
  return selected.toReversed().flat()
}

/** Include whole sibling groups where possible; floor prevents long groups from growing pages unbounded. */
export function wholeSubagentGroupsStart(
  items: readonly AgentJournalRenderItem[],
  start: number,
  floor: number
): number {
  const firstOf = new Map<string, number>()
  for (const item of items) {
    const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
    if (block !== null && !firstOf.has(subagentFoldKey(block))) {
      firstOf.set(subagentFoldKey(block), item.sequence)
    }
  }
  let whole = start
  for (let index = items.length - 1; index >= 0 && items[index]!.sequence >= whole; index--) {
    const item = items[index]!
    const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
    if (block !== null) {
      whole = Math.max(floor, Math.min(whole, firstOf.get(subagentFoldKey(block))!))
    }
  }
  return whole
}

/** Window by own-agent rows, retaining contiguous subagent work and whole sibling groups within byte bounds. */
export function conversationWindow(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  const own = items.filter((item) => isRootAgentJournalItem(item) && !isSubagentRow(item))
  if (own.length === items.length) {
    return newestWholeSequenceGroups(items, limit)
  }
  const ownWindow = newestWholeSequenceGroups(own, limit)
  const start = ownWindow.length < own.length ? ownWindow[0]?.sequence : undefined
  if (start === undefined) {
    return [...items]
  }
  const reach = newestWholeSequenceGroups(own, 2 * limit)
  const floor = reach.length < own.length ? reach[0]!.sequence : Number.NEGATIVE_INFINITY
  const whole = wholeSubagentGroupsStart(items, start, floor)
  return items.filter((item) => item.sequence >= whole)
}

function isSubagentRow(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'message' && item.body.blocks.some(isSubagentBlock)
}
