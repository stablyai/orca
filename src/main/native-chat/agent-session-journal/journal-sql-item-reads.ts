import {
  readJournalHistoryItems,
  readClaudeHistoryPrompts,
  type JournalHistoryItem,
  type JournalHistoryReadOptions,
  type JournalHistoryPrompt
} from './journal-history-items'
import { journalSqlHistoryOpeners, journalSqlUserItemIds } from './journal-sql-history-items'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionContextUsage } from '../../../shared/agent-session/agent-session-context-usage'
import { latestStructuredAgentContextFacts } from '../../../shared/agent-session/structured-agent-session-context-usage'
import { runningStructuredAgentSessionTurnItemBySequence } from '../../../shared/agent-session/view/structured-agent-session-live-turn'
import {
  journalThreadGoalSource,
  type JournalThreadGoalSource
} from './projection/journal-thread-goal-source'
import type { JournalSqlScope } from './journal-sql-scope'
import type {
  JournalContinuationContext,
  JournalMessageOptions,
  JournalNamedTurn
} from './journal-reads'
import { readJournalSqlContinuationContext } from './journal-sql-continuation-context'
import { JournalSqlReadValues } from './journal-sql-read-values'
import { readJournalSqlInput } from './journal-sql-input-reads'
import { agentJournalSubmissionKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { currentAgentSessionThreadGoalSourceBySequence } from '../../../shared/agent-session/agent-session-thread-goal'
import type { ClaudeJournalSnapshot } from '../../claude/claude-subagent-journaled-identities'
import { readJournalSqlClaudeIdentities } from './journal-sql-claude-identities'
import {
  readJournalSqlLifecycle,
  type JournalSqlLifecycleRead,
  type JournalSqlLifecycleReadResult
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

export type JournalSqlItemReadContext = {
  scope: JournalSqlScope
  item: (itemId: string) => AgentJournalRenderItem | undefined
  visible: (itemId: string) => boolean
  epoch: () => string
}

const TURNS_NEWEST_FIRST = `SELECT entry_key, context_clear FROM journal_proj_items
  WHERE session_id=? AND epoch=? AND (turn_id IS NOT NULL OR context_clear=1)
  ORDER BY sequence DESC, ordinal DESC`

export function readJournalSqlItems(
  context: JournalSqlItemReadContext,
  operation: JournalSqlItemRead
): JournalSqlItemReadResult {
  const { scope } = context
  switch (operation.kind) {
    case 'canonical-item-ids': {
      const values = new JournalSqlReadValues(scope, () => {})
      return {
        kind: 'canonical-item-ids',
        items: operation.itemIds.map((itemId) => ({
          itemId,
          canonicalItemId: values.get<string>('aliases', itemId) ?? itemId
        }))
      }
    }
    case 'history-items': {
      const values = new JournalSqlReadValues(scope, () => {})
      const canonical = (key: string) => values.get<string>('aliases', key) ?? key
      return {
        kind: 'history-items',
        items: readJournalHistoryItems(
          {
            canonicalItemId: canonical,
            item: (key) => (context.visible(key) ? (context.item(key) ?? null) : null),
            presentationRemoved: (key) => {
              const itemId = canonical(key)
              return values.has('tombstones', itemId) || !context.visible(itemId)
            },
            ...(operation.options?.includeOpeners
              ? { turnsOpenedBy: (key: string) => journalSqlHistoryOpeners(scope, key) }
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
          journalSqlUserItemIds(scope, context.visible),
          operation.sessionId,
          operation.uuids
        )
      }
    case 'continuation-context':
      return { kind: 'continuation-context', context: readJournalSqlContinuationContext(scope) }
    case 'message-options': {
      const itemId = agentJournalSubmissionKey(operation.clientMessageId)
      const body = context.visible(itemId) ? context.item(itemId)?.body : undefined
      const newest = readJournalSqlInput(scope, { kind: 'newest-turn' })
      if (newest.kind !== 'newest-turn') {
        throw new Error('journal newest turn read returned a different answer')
      }
      return {
        kind: 'message-options',
        options: {
          ordinaryMessage: body?.kind === 'message' && !body.command,
          runningTurn: newest.turn?.state === 'running'
        }
      }
    }
    case 'named-turn': {
      const row = scope.db
        .prepare(`SELECT entry_key FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0
        ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
        .get(...scope.prefix, operation.turnId)
      if (row) {
        scope.examined(row)
      }
      return {
        kind: 'named-turn',
        turn: {
          scope: row ? { kind: 'turn', turnItemId: entryItemId(row) } : null,
          removed: new JournalSqlReadValues(scope, () => {}).has('removedTurnIds', operation.turnId)
        }
      }
    }
    case 'items-by-kind': {
      const kinds = [...new Set(operation.kinds)]
      const rows = kinds.length
        ? scope.db
            .prepare(`SELECT entry_key, ordinal FROM journal_proj_items
            WHERE session_id=? AND epoch=? AND kind IN (${kinds.map(() => '?').join(',')})
            AND ordinal>? ORDER BY ordinal LIMIT ?`)
            .all(...scope.prefix, ...kinds, operation.afterOrdinal, operation.limit + 1)
        : []
      const page = rows.slice(0, operation.limit)
      const items: AgentJournalRenderItem[] = []
      for (const row of page) {
        scope.examined(row)
        const itemId = entryItemId(row)
        const item = context.visible(itemId) ? context.item(itemId) : undefined
        if (item) {
          items.push(item)
        }
      }
      return {
        kind: 'items-by-kind',
        items,
        nextOrdinal: rows.length > operation.limit ? Number(page.at(-1)!.ordinal) : null
      }
    }
    case 'context-floor': {
      const row = scope.db
        .prepare(`SELECT sequence FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND context_clear=1 ORDER BY sequence DESC LIMIT 1`)
        .get(...scope.prefix)
      return {
        kind: 'context-floor',
        floor: row ? { epoch: context.epoch(), sequence: Number(row.sequence) } : null
      }
    }
    case 'running-turn': {
      const row = scope.db.prepare(`${TURNS_NEWEST_FIRST} LIMIT 1`).get(...scope.prefix)
      const item = row ? context.item(entryItemId(row)) : undefined
      return {
        kind: 'running-turn',
        running: item ? runningStructuredAgentSessionTurnItemBySequence([item]) : null
      }
    }
    case 'context-usage': {
      // Facts before the newest clear never count, so the walk stops there.
      const turns: AgentJournalRenderItem[] = []
      for (const row of scope.db.prepare(TURNS_NEWEST_FIRST).iterate(...scope.prefix)) {
        scope.examined(row)
        const item = context.item(entryItemId(row))
        if (item) {
          turns.push(item)
        }
        if (Number(row.context_clear) === 1) {
          break
        }
      }
      return { kind: 'context-usage', usage: latestStructuredAgentContextFacts(turns.toReversed()) }
    }
    case 'claude-snapshot':
      return {
        kind: 'claude-snapshot',
        snapshot: { ...readJournalSqlClaudeIdentities(scope), threadGoal: readThreadGoal(context) }
      }
    case 'thread-goal-source':
      return { kind: 'thread-goal-source', source: readThreadGoal(context) }
    case 'latest-prompt':
    case 'restart-progress':
    case 'outgrown-child':
      return readJournalSqlLifecycle(context, operation)
  }
}

/** The newest transition wins; on equal sequence the earlier-written row, as a fold scan keeps it. */
function readThreadGoal(context: JournalSqlItemReadContext): JournalThreadGoalSource {
  const { scope } = context
  const rows = scope.db
    .prepare(`SELECT entry_key FROM journal_proj_items
    WHERE session_id=? AND epoch=? AND ((kind='status' AND root=1) OR context_clear=1)
    ORDER BY sequence DESC, ordinal ASC`)
    .iterate(...scope.prefix)
  for (const row of rows) {
    scope.examined(row)
    const item = context.item(entryItemId(row))
    if (item && currentAgentSessionThreadGoalSourceBySequence([item])) {
      return journalThreadGoalSource([item])
    }
  }
  return journalThreadGoalSource([])
}

/** Item rows key by the JSON-encoded item id. */
function entryItemId(row: Record<string, unknown>): string {
  return String(JSON.parse(String(row.entry_key)))
}
