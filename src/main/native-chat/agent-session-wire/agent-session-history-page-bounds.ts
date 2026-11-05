import { finishJournalSteps } from '../agent-session-journal/journal-reconstruction-steps'
import {
  type AgentSessionHistoryDirection,
  type AgentSessionSubagentRosterEntry,
  AGENT_SESSION_HISTORY_DEFAULT_LIMIT,
  AGENT_SESSION_HISTORY_MAX_LIMIT
} from '../../../shared/agent-session/agent-session-wire'
import {
  agentJournalSubmissionKey,
  boundJournalKeyComponent
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type {
  AgentJournalRenderItem,
  AgentJournalSnapshot,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES } from '../../../shared/remote-runtime/remote-runtime-memory-limits'
import { MOBILE_BRIDGE_MAX_FRAME_BYTES } from '../../../shared/mobile-bridge-frame-bytes'
import { agentSessionHostStatusBody } from '../../../shared/agent-session/view/agent-session-host-status-rows'
import { isSubagentBlock } from '../../../shared/native-chat/native-chat-types'
import {
  subagentFoldKey,
  subagentItemBlock
} from '../../../shared/native-chat/transcript/native-chat-subagent-items'
import type { AgentSessionJournal } from '../agent-session-journal/journal-store'

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

/** Count removal IDs and submissions alongside the exact items sent to a reader. */
export function historyContentBytes(
  items: readonly HistoryItemForm[],
  removedItemIds: readonly string[],
  submissionBytes: ReadonlyMap<string, number>
): number {
  return (
    items.reduce(
      (total, { item, bytes }) => total + bytes + (submissionBytes.get(item.itemId) ?? 0),
      0
    ) +
    removedItemIds.reduce(
      (total, itemId) => total + Buffer.byteLength(JSON.stringify(itemId), 'utf8') + 1,
      0
    )
  )
}

// Snapshot arrays change with submissions, so cache serialization once per paged snapshot.
const bytesBySubmissions = new WeakMap<
  readonly AgentJournalSubmission[],
  ReadonlyMap<string, number>
>()

export function submissionBytesByItemId(
  submissions: readonly AgentJournalSubmission[]
): ReadonlyMap<string, number> {
  return finishJournalSteps(submissionBytesByItemIdSteps(submissions))
}

export function* submissionBytesByItemIdSteps(
  submissions: readonly AgentJournalSubmission[]
): Generator<void, ReadonlyMap<string, number>> {
  const cached = bytesBySubmissions.get(submissions)
  if (cached) {
    return cached
  }
  const bytes = new Map<string, number>()
  for (const submission of submissions) {
    bytes.set(
      agentJournalSubmissionKey(submission.clientMessageId),
      Buffer.byteLength(JSON.stringify(submission), 'utf8')
    )
    yield
  }
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
  /** Forward reads project touched identities; cold reads include retained sources before bounds. */
  snapshot?: (
    journal: AgentSessionJournal,
    snapshot?: AgentJournalSnapshot,
    touched?: ReadonlySet<string>
  ) => AgentJournalSnapshot
  queueSourceIds?: (journal: AgentSessionJournal, messageId: string) => readonly string[]
}

export function boundHistoryItemsByBytes(
  items: AgentJournalRenderItem[],
  keep: 'newest' | 'oldest',
  submissionBytes: ReadonlyMap<string, number>,
  maxBytes: number,
  form: HistoryReader['form'] = measureHistoryItem
): { items: AgentJournalRenderItem[]; dropped: number } {
  return finishJournalSteps(
    boundHistoryItemsByBytesSteps(items, keep, submissionBytes, maxBytes, form)
  )
}

export function* boundHistoryItemsByBytesSteps(
  items: AgentJournalRenderItem[],
  keep: 'newest' | 'oldest',
  submissionBytes: ReadonlyMap<string, number>,
  maxBytes: number,
  form: HistoryReader['form'] = measureHistoryItem
): Generator<void, { items: AgentJournalRenderItem[]; dropped: number }> {
  const ordered = groupItemsBySequence(items, keep)
  const kept: AgentJournalRenderItem[][] = []
  let total = 0
  for (;;) {
    const next = ordered.next()
    if (next.done) {
      break
    }
    if (!next.value) {
      yield
      continue
    }
    const stored = next.value
    const group: AgentJournalRenderItem[] = []
    let bytes = 0
    for (const item of stored) {
      const formed = form(item)
      group.push(formed.item)
      bytes += formed.bytes + (submissionBytes.get(formed.item.itemId) ?? 0)
      yield
    }
    if (kept.length === 0 && bytes > maxBytes) {
      const oversized: AgentJournalRenderItem[] = []
      for (const item of group) {
        oversized.push(oversizedHistoryItem(item))
        yield
      }
      kept.push(oversized)
      break
    }
    if (total + bytes > maxBytes) {
      break
    }
    kept.push(group)
    total += bytes
  }
  const result: AgentJournalRenderItem[] = []
  const groups = keep === 'newest' ? kept.toReversed() : kept
  for (const group of groups) {
    for (const item of group) {
      result.push(item)
      yield
    }
  }
  return { items: result, dropped: items.length - result.length }
}

/** Group only visited adjacent sequence runs, preserving item order in either traversal direction. */
function* groupItemsBySequence(
  items: readonly AgentJournalRenderItem[],
  keep: 'newest' | 'oldest'
): Generator<AgentJournalRenderItem[] | void> {
  let cursor = keep === 'newest' ? items.length : 0
  while (keep === 'newest' ? cursor > 0 : cursor < items.length) {
    if (keep === 'newest') {
      let start = cursor - 1
      const sequence = items[start].sequence
      while (start > 0 && items[start - 1].sequence === sequence) {
        start -= 1
        yield
      }
      const group: AgentJournalRenderItem[] = []
      for (let index = start; index < cursor; index++) {
        group.push(items[index])
        yield
      }
      yield group
      cursor = start
    } else {
      let end = cursor + 1
      const sequence = items[cursor].sequence
      while (end < items.length && items[end].sequence === sequence) {
        end += 1
        yield
      }
      const group: AgentJournalRenderItem[] = []
      for (let index = cursor; index < end; index++) {
        group.push(items[index])
        yield
      }
      yield group
      cursor = end
    }
  }
}

export function newestWholeSequenceGroups(
  items: readonly AgentJournalRenderItem[],
  limit: number
): AgentJournalRenderItem[] {
  return finishJournalSteps(newestWholeSequenceGroupsSteps(items, limit))
}

export function* newestWholeSequenceGroupsSteps(
  items: readonly AgentJournalRenderItem[],
  limit: number
): Generator<void, AgentJournalRenderItem[]> {
  const selected: AgentJournalRenderItem[][] = []
  let count = 0
  const groups = groupItemsBySequence(items, 'newest')
  for (;;) {
    const next = groups.next()
    if (next.done) {
      break
    }
    const group = next.value
    if (!group) {
      yield
      continue
    }
    if (selected.length > 0 && count + group.length > limit) {
      break
    }
    selected.push(group)
    count += group.length
  }
  const result: AgentJournalRenderItem[] = []
  for (const group of selected.toReversed()) {
    for (const item of group) {
      result.push(item)
      yield
    }
  }
  return result
}

/** Include whole sibling groups where possible; floor prevents long groups from growing pages unbounded. */
export function wholeSubagentGroupsStart(
  items: readonly AgentJournalRenderItem[],
  start: number,
  floor: number
): number {
  return finishJournalSteps(wholeSubagentGroupsStartSteps(items, start, floor))
}

export function* wholeSubagentGroupsStartSteps(
  items: readonly AgentJournalRenderItem[],
  start: number,
  floor: number
): Generator<void, number> {
  const firstOf = new Map<string, number>()
  for (const item of items) {
    yield
    const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
    if (block !== null && !firstOf.has(subagentFoldKey(block))) {
      firstOf.set(subagentFoldKey(block), item.sequence)
    }
  }
  let whole = start
  for (let index = items.length - 1; index >= 0 && items[index]!.sequence >= whole; index--) {
    yield
    const item = items[index]!
    const block = item.body.kind === 'message' ? subagentItemBlock(item.body) : null
    if (block !== null) {
      whole = Math.max(floor, Math.min(whole, firstOf.get(subagentFoldKey(block))!))
    }
  }
  return whole
}

export function resolveHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return AGENT_SESSION_HISTORY_DEFAULT_LIMIT
  }
  return Math.min(AGENT_SESSION_HISTORY_MAX_LIMIT, Math.max(1, Math.floor(limit)))
}

export function isSubagentRow(item: AgentJournalRenderItem): boolean {
  return item.body.kind === 'message' && item.body.blocks.some(isSubagentBlock)
}

export type HistoryPageInput = {
  snapshot: AgentJournalSnapshot
  submissions?: AgentJournalSnapshot['submissions']
  direction: AgentSessionHistoryDirection
  items: AgentJournalRenderItem[]
  removedItemIds?: string[]
  hasOlder: boolean
  hasNewer: boolean
  fallbackCursor: AgentJournalCursor
  nextCursor: AgentJournalCursor | undefined
  fence?: number
  subagentRoster?: AgentSessionSubagentRosterEntry[]
}
