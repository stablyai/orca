import { serialize } from 'node:v8'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { claudePromptUuidForSubmission } from '../../claude/structured/lifecycle/claude-structured-session-id'

export const JOURNAL_HISTORY_ITEMS_LIMIT = 4_096
const JOURNAL_HISTORY_ITEMS_BYTES = 16 * 1024 * 1024
const HISTORY_WORKSPACE_TOO_LARGE = 'history-workspace-too-large'

export type JournalHistoryItem = {
  key: string
  canonicalItemId: string
  item: AgentJournalRenderItem | null
  removed: boolean
  openedTurnIds?: readonly string[]
}

export type JournalHistoryItemSource = {
  canonicalItemId: (key: string) => string
  item: (key: string) => AgentJournalRenderItem | null
  presentationRemoved: (key: string) => boolean
  turnsOpenedBy?: (key: string) => Iterable<string>
}

export type JournalHistoryReadOptions = {
  includeOpeners?: boolean
  includePlacement?: false
  maxReplyBytes?: number
}
export type JournalHistoryPrompt = { uuid: string; itemId: string }

/** One bounded observation includes the named rows and their saved placement dependencies. */
export function readJournalHistoryItems(
  source: JournalHistoryItemSource,
  itemIds: readonly string[],
  options?: JournalHistoryReadOptions
): JournalHistoryItem[] {
  const pending = new Set(itemIds)
  const requested = new Set(itemIds)
  const result: JournalHistoryItem[] = []
  const includePlacement = options?.includePlacement !== false
  const maxReplyBytes = options?.maxReplyBytes
  // Allow for the enclosing reader reply, its credit metadata and array indices.
  let bytes = maxReplyBytes === undefined ? 0 : 128
  for (const key of pending) {
    if (pending.size > JOURNAL_HISTORY_ITEMS_LIMIT) {
      throw new Error(HISTORY_WORKSPACE_TOO_LARGE)
    }
    const canonicalItemId = source.canonicalItemId(key)
    if (includePlacement) {
      pending.add(canonicalItemId)
    }
    const item = source.item(canonicalItemId)
    let openedTurnIds: string[] | undefined
    if (
      requested.has(key) &&
      item?.body.kind === 'message' &&
      item.body.role === 'user' &&
      source.turnsOpenedBy
    ) {
      openedTurnIds = []
      for (const turnItemId of source.turnsOpenedBy(canonicalItemId)) {
        pending.add(turnItemId)
        openedTurnIds.push(turnItemId)
        if (pending.size > JOURNAL_HISTORY_ITEMS_LIMIT) {
          throw new Error(HISTORY_WORKSPACE_TOO_LARGE)
        }
      }
    }
    const entry = {
      key,
      canonicalItemId,
      item,
      removed: source.presentationRemoved(key),
      ...(openedTurnIds ? { openedTurnIds } : {})
    }
    bytes +=
      maxReplyBytes === undefined
        ? Buffer.byteLength(JSON.stringify(entry))
        : serialize(entry).byteLength + 8
    if (bytes > Math.min(maxReplyBytes ?? Infinity, JOURNAL_HISTORY_ITEMS_BYTES)) {
      throw new Error(HISTORY_WORKSPACE_TOO_LARGE)
    }
    result.push(entry)
    if (includePlacement && item?.turnScope?.kind === 'turn') {
      pending.add(item.turnScope.turnItemId)
    }
    if (includePlacement && item?.body.kind === 'turn' && item.body.userItemId) {
      pending.add(item.body.userItemId)
    }
  }
  return result
}

/** A source group retains only its named observation, never a chat-wide projection. */
export function createJournalHistoryItems() {
  const entries = new Map<string, JournalHistoryItem>()
  const sizes = new Map<string, number>()
  const openers = new Map<string, readonly string[]>()
  let bytes = 0
  return {
    adopt(items: readonly JournalHistoryItem[]) {
      for (const entry of items) {
        const size = Buffer.byteLength(JSON.stringify(entry))
        bytes += size - (sizes.get(entry.key) ?? 0)
        sizes.set(entry.key, size)
        entries.set(entry.key, entry)
        if (entry.openedTurnIds) {
          openers.set(entry.canonicalItemId, entry.openedTurnIds)
        }
        if (entries.size > JOURNAL_HISTORY_ITEMS_LIMIT || bytes > JOURNAL_HISTORY_ITEMS_BYTES) {
          throw new Error('history-workspace-too-large')
        }
      }
    },
    clear() {
      entries.clear()
      sizes.clear()
      openers.clear()
      bytes = 0
    },
    canonicalItemId: (key: string): string => entries.get(key)?.canonicalItemId ?? key,
    item: (key: string): AgentJournalRenderItem | null => entries.get(key)?.item ?? null,
    itemBody: (key: string): AgentJournalItemBody | null => entries.get(key)?.item?.body ?? null,
    presentationRemoved: (key: string): boolean => entries.get(key)?.removed ?? false,
    openedTurnIds: (key: string): readonly string[] => openers.get(key) ?? []
  }
}

export type JournalHistoryItems = ReturnType<typeof createJournalHistoryItems>

/** Lost acknowledgements can still name a native submission by its deterministic prompt UUID. */
export function readClaudeHistoryPrompts(
  userItemIds: Iterable<string>,
  sessionId: string,
  uuids: readonly string[]
): JournalHistoryPrompt[] {
  if (uuids.length > JOURNAL_HISTORY_ITEMS_LIMIT) {
    throw new Error('history-workspace-too-large')
  }
  const wanted = new Set(uuids)
  const result: JournalHistoryPrompt[] = []
  if (!wanted.size) {
    return result
  }
  for (const itemId of userItemIds) {
    if (parseAgentJournalItemKey(itemId)?.provider !== 'orca') {
      continue
    }
    const uuid = claudePromptUuidForSubmission(sessionId, itemId)
    if (wanted.has(uuid)) {
      result.push({ uuid, itemId })
    }
  }
  return result
}
