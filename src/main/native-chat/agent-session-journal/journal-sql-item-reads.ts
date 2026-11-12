import type Database from '../../sqlite/sync-database'
import {
  readJournalHistoryItems,
  readClaudeHistoryPrompts,
  type JournalHistoryItem,
  type JournalHistoryReadOptions,
  type JournalHistoryPrompt
} from './journal-history-items'
import { journalDomainHistoryOpeners, journalDomainUserItemIds } from './journal-sql-history-items'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/agent-session/structured-agent-session-context-usage'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import { isAgentSessionContextClear } from '../../../shared/agent-session/agent-session-context-clear'
import {
  journalThreadGoalSource,
  type JournalThreadGoalSource
} from './projection/journal-thread-goal-source'
import type {
  JournalContinuationContext,
  JournalMessageOptions,
  JournalNamedTurn
} from './journal-reads'
import {
  journalDomainContextHead,
  readJournalDomainContinuationContext
} from './journal-sql-continuation-context'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { ClaudeJournalSnapshot } from '../../claude/subagents/claude-subagent-journaled-identities'
import { readJournalDomainClaudeIdentities } from './journal-sql-claude-identities'
import type {
  JournalSqlLifecycleRead,
  JournalSqlLifecycleReadResult
} from './journal-sql-lifecycle-reads'

/** Item reads by type and position; each names the rows it decodes, as projection reads do. */
export type JournalSqlItemRead =
  | {
      kind: 'items-by-kind'
      kinds: readonly AgentJournalItemBody['kind'][]
      afterOrdinal: number
      limit: number
    }
  | { kind: 'history-items'; itemIds: readonly string[]; options?: JournalHistoryReadOptions }
  | { kind: 'claude-history-prompts'; sessionId: string; uuids: readonly string[] }
  | { kind: 'canonical-item-ids'; itemIds: readonly string[] }
  | { kind: 'context-floor' }
  | { kind: 'running-turn' }
  | { kind: 'context-usage' }
  | { kind: 'thread-goal-source' }
  | { kind: 'claude-snapshot' }
  | { kind: 'named-turn'; turnId: string }
  | { kind: 'message-options'; clientMessageId: string }
  | { kind: 'continuation-context' }
  | JournalSqlLifecycleRead

export type JournalSqlItemReadResult =
  | { kind: 'items-by-kind'; items: AgentJournalRenderItem[]; nextOrdinal: number | null }
  | { kind: 'history-items'; items: readonly JournalHistoryItem[] }
  | { kind: 'claude-history-prompts'; prompts: readonly JournalHistoryPrompt[] }
  | { kind: 'canonical-item-ids'; items: { itemId: string; canonicalItemId: string }[] }
  | { kind: 'context-floor'; floor: AgentJournalCursor | null }
  | { kind: 'running-turn'; running: { item: AgentJournalRenderItem; turnId: string } | null }
  | { kind: 'context-usage'; usage: AgentSessionContextUsage }
  | { kind: 'thread-goal-source'; source: JournalThreadGoalSource }
  | { kind: 'claude-snapshot'; snapshot: ClaudeJournalSnapshot }
  | { kind: 'named-turn'; turn: JournalNamedTurn }
  | { kind: 'message-options'; options: JournalMessageOptions }
  | { kind: 'continuation-context'; context: JournalContinuationContext }
  | JournalSqlLifecycleReadResult

export type JournalDomainItemRead = Exclude<JournalSqlItemRead, JournalSqlLifecycleRead>
export type JournalDomainItemReadResult = Exclude<
  JournalSqlItemReadResult,
  JournalSqlLifecycleReadResult
>

export type JournalDomainItemTarget = { sessionId: string; epoch: string }

/** Turns and clears, newest first; ties keep the later-admitted row, as an insertion-order fold does. */
const TURNS_NEWEST_FIRST = `SELECT payload_json FROM journal_items INDEXED BY journal_items_turn_marker
  WHERE session_id=? AND epoch=? AND hidden=0 AND turn_marker=1
  ORDER BY sequence DESC, ordinal DESC`

/** Runs on the caller's open reader snapshot; it never writes, waits or caches. */
export function readJournalDomainItems(
  db: Database.Database,
  target: JournalDomainItemTarget,
  operation: JournalDomainItemRead
): JournalDomainItemReadResult {
  const prefix = [target.sessionId, target.epoch] as const
  switch (operation.kind) {
    case 'canonical-item-ids': {
      const canonical = canonicalItemId(db, prefix)
      return {
        kind: 'canonical-item-ids',
        items: operation.itemIds.map((itemId) => ({ itemId, canonicalItemId: canonical(itemId) }))
      }
    }
    case 'history-items': {
      const canonical = canonicalItemId(db, prefix)
      const removed = db.prepare(`SELECT
        EXISTS(SELECT 1 FROM journal_item_tombstones WHERE session_id=?1 AND epoch=?2 AND item_id=?3)
        OR EXISTS(SELECT 1 FROM journal_items WHERE session_id=?1 AND epoch=?2 AND item_id=?3 AND hidden=1)
        AS removed`)
      return {
        kind: 'history-items',
        items: readJournalHistoryItems(
          {
            canonicalItemId: canonical,
            item: (itemId) => visibleItem(db, prefix, itemId),
            presentationRemoved: (key) => Boolean(removed.get(...prefix, canonical(key))!.removed),
            ...(operation.options?.includeOpeners
              ? {
                  turnsOpenedBy: (itemId: string) => journalDomainHistoryOpeners(db, prefix, itemId)
                }
              : {})
          },
          operation.itemIds
        )
      }
    }
    case 'claude-history-prompts':
      return {
        kind: 'claude-history-prompts',
        prompts: readClaudeHistoryPrompts(
          journalDomainUserItemIds(db, prefix),
          operation.sessionId,
          operation.uuids
        )
      }
    case 'continuation-context':
      return {
        kind: 'continuation-context',
        context: readJournalDomainContinuationContext(db, target)
      }
    case 'message-options': {
      const body = visibleItem(
        db,
        prefix,
        agentJournalSubmissionKey(operation.clientMessageId)
      )?.body
      return {
        kind: 'message-options',
        options: {
          ordinaryMessage: body?.kind === 'message' && !body.command,
          runningTurn:
            readAgentJournalTurn(newestJournalDomainTurnOrClear(db, prefix)?.body)?.state ===
            'running'
        }
      }
    }
    case 'named-turn': {
      const row = db
        .prepare(`SELECT item_id FROM journal_items INDEXED BY journal_items_named_turn
        WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0
        ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
        .get(...prefix, operation.turnId)
      return {
        kind: 'named-turn',
        turn: {
          scope: row ? { kind: 'turn', turnItemId: String(row.item_id) } : null,
          removed: Boolean(
            db
              .prepare(`SELECT 1 FROM journal_removed_turns
              WHERE session_id=? AND epoch=? AND turn_id=?`)
              .get(...prefix, operation.turnId)
          )
        }
      }
    }
    case 'items-by-kind': {
      const kinds = [...new Set(operation.kinds)]
      const headers = kinds
        .flatMap((kind) =>
          db
            .prepare(`SELECT item_id,ordinal FROM journal_items INDEXED BY journal_items_kind
          WHERE session_id=? AND epoch=? AND hidden=0 AND kind=? AND ordinal>?
          ORDER BY ordinal LIMIT ?`)
            .all(...prefix, kind, operation.afterOrdinal, operation.limit + 1)
        )
        .sort((a, b) => Number(a.ordinal) - Number(b.ordinal))
      const chosen = headers.slice(0, operation.limit)
      const page = db
        .prepare(`SELECT item.payload_json FROM json_each(?) chosen
        CROSS JOIN journal_items item WHERE item.session_id=? AND item.epoch=?
          AND item.item_id=chosen.value ORDER BY CAST(chosen.key AS INTEGER)`)
        .all(JSON.stringify(chosen.map((header) => header.item_id)), ...prefix)
      return {
        kind: 'items-by-kind',
        items: page.map(parseItem),
        nextOrdinal: headers.length > operation.limit ? Number(chosen.at(-1)!.ordinal) : null
      }
    }
    case 'context-floor': {
      const row = db
        .prepare(`SELECT sequence FROM journal_items INDEXED BY journal_items_context_clear
        WHERE session_id=? AND epoch=? AND hidden=0 AND context_clear=1 ORDER BY sequence DESC LIMIT 1`)
        .get(...prefix)
      return {
        kind: 'context-floor',
        floor: row
          ? { epoch: journalDomainContextHead(db, target).epoch, sequence: Number(row.sequence) }
          : null
      }
    }
    case 'running-turn': {
      const row = db.prepare(`${TURNS_NEWEST_FIRST} LIMIT 1`).get(...prefix)
      return {
        kind: 'running-turn',
        running: row ? runningStructuredAgentSessionTurnItemBySequence([parseItem(row)]) : null
      }
    }
    case 'context-usage':
      return { kind: 'context-usage', usage: readContextUsage(db, prefix) }
    case 'claude-snapshot':
      return {
        kind: 'claude-snapshot',
        snapshot: {
          ...readJournalDomainClaudeIdentities(db, prefix),
          threadGoal: readThreadGoal(db, prefix)
        }
      }
    case 'thread-goal-source':
      return { kind: 'thread-goal-source', source: readThreadGoal(db, prefix) }
  }
}

type Prefix = readonly [string, string]

function canonicalItemId(db: Database.Database, prefix: Prefix): (key: string) => string {
  const alias = db.prepare(`SELECT item_id FROM journal_item_aliases
    WHERE session_id=? AND epoch=? AND provider_item_id=?`)
  return (key) => {
    const row = alias.get(...prefix, key)
    return row ? String(row.item_id) : key
  }
}

function visibleItem(
  db: Database.Database,
  prefix: Prefix,
  itemId: string
): AgentJournalRenderItem | null {
  const row = db
    .prepare(`SELECT payload_json FROM journal_items
    WHERE session_id=? AND epoch=? AND item_id=? AND hidden=0`)
    .get(...prefix, itemId)
  return row ? parseItem(row) : null
}

/** The input order's newest turn: latest position, then the greatest item ID among ties. */
export function newestJournalDomainTurnOrClear(
  db: Database.Database,
  prefix: Prefix
): AgentJournalRenderItem | null {
  let newest: AgentJournalRenderItem | null = null
  for (const row of db
    .prepare(`SELECT payload_json FROM journal_items INDEXED BY journal_items_turn_marker
    WHERE session_id=? AND epoch=? AND hidden=0 AND turn_marker=1
    ORDER BY sequence DESC, sequence_index DESC`)
    .iterate(...prefix)) {
    const item = parseItem(row)
    if (
      newest &&
      (item.sequence !== newest.sequence ||
        (item.sequenceIndex ?? 0) !== (newest.sequenceIndex ?? 0))
    ) {
      break
    }
    if (!newest || item.itemId.localeCompare(newest.itemId) > 0) {
      newest = item
    }
  }
  return newest
}

/** Walks back to the newest clear, stopping early once older rows can no longer change either fact. */
function readContextUsage(db: Database.Database, prefix: Prefix): AgentSessionContextUsage {
  const turns: AgentJournalRenderItem[] = []
  let used: number | null = null
  let window: number | null = null
  for (const row of db.prepare(TURNS_NEWEST_FIRST).iterate(...prefix)) {
    const item = parseItem(row)
    if (used !== null && window !== null && item.sequence < Math.min(used, window)) {
      break
    }
    turns.push(item)
    if (isAgentSessionContextClear(item.body)) {
      break
    }
    const facts = readAgentJournalTurn(item.body)?.contextUsage
    used ??= facts?.used ? item.sequence : null
    window ??= facts?.window ? item.sequence : null
  }
  return latestStructuredAgentContextFacts(turns.toReversed())
}

/** The newest transition wins; on equal sequence the earlier-admitted row, as a fold scan keeps it. */
function readThreadGoal(db: Database.Database, prefix: Prefix): JournalThreadGoalSource {
  const row = db
    .prepare(`SELECT payload_json FROM journal_items INDEXED BY journal_items_goal_transition
    WHERE session_id=? AND epoch=? AND hidden=0 AND goal_transition=1
    ORDER BY sequence DESC, ordinal ASC LIMIT 1`)
    .get(...prefix)
  return journalThreadGoalSource(row ? [parseItem(row)] : [])
}

function parseItem(row: Record<string, unknown>): AgentJournalRenderItem {
  return JSON.parse(String(row.payload_json))
}
