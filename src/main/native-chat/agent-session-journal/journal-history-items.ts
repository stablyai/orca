import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { parseAgentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { claudePromptUuidForSubmission } from '../../claude/structured/claude-structured-session-id'

export const JOURNAL_HISTORY_ITEMS_LIMIT = 4_096
const JOURNAL_HISTORY_ITEMS_BYTES = 16 * 1024 * 1024

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

export type JournalHistoryReadOptions = { includeOpeners?: boolean }
export type JournalHistoryPrompt = { uuid: string; itemId: string }

/** One bounded observation includes the named rows and their saved placement dependencies. */
export function readJournalHistoryItems(
  source: JournalHistoryItemSource,
  itemIds: readonly string[]
): JournalHistoryItem[] {
  const pending = new Set(itemIds)
  const requested = new Set(itemIds)
  const result: JournalHistoryItem[] = []
  let bytes = 0
  for (const key of pending) {
    if (pending.size > JOURNAL_HISTORY_ITEMS_LIMIT) {
      throw new Error('history-workspace-too-large')
    }
    const canonicalItemId = source.canonicalItemId(key)
    pending.add(canonicalItemId)
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
          throw new Error('history-workspace-too-large')
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
    bytes += Buffer.byteLength(JSON.stringify(entry))
    if (bytes > JOURNAL_HISTORY_ITEMS_BYTES) {
      throw new Error('history-workspace-too-large')
    }
    result.push(entry)
    if (item?.turnScope?.kind === 'turn') {
      pending.add(item.turnScope.turnItemId)
    }
    if (item?.body.kind === 'turn' && item.body.userItemId) {
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
