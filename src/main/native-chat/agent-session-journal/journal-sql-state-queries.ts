import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalStateQueries } from './journal-state-queries'
import { memoryJournalMap } from './journal-memory-collections'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import type { JournalSqlQueryFacts } from './journal-sql-query-facts'
import { journalSqlOrderedValues } from './journal-sql-keyed-values'
import type { QueuedMessageRow } from './queued-messages/queued-message-table'
import { JournalSqlStatusContext } from './journal-sql-status-context'
import { readJournalSqlUsageLimitContinueIdentity } from './journal-sql-status-cuts'

export function sqlJournalStateQueries(
  context: JournalSqlValueContext,
  facts: JournalSqlQueryFacts
): JournalStateQueries {
  const { scope } = context
  const candidateRows = (
    column: 'effective_fence' | 'handover_fence',
    fence: number
  ): AgentJournalSubmission[] => {
    facts.flush()
    return scope.db
      .prepare(`SELECT input_id FROM journal_proj_input_candidates
      WHERE session_id=? AND epoch=? AND current=1 AND ${column}=? ORDER BY ordinal`)
      .all(...scope.prefix, fence)
      .map((row) => {
        scope.examined(row)
        return context.read<AgentJournalSubmission>(
          'inputs.candidates',
          JSON.stringify(row.input_id)
        )!
      })
  }
  const latestClear = (): number => {
    facts.flush()
    const row = scope.db
      .prepare(`SELECT sequence FROM journal_proj_items
      WHERE session_id=? AND epoch=? AND context_clear=1 ORDER BY sequence DESC LIMIT 1`)
      .get(...scope.prefix)
    if (row) {
      scope.examined(row)
    }
    return Number(row?.sequence ?? 0)
  }
  return {
    usageLimitContinueIdentity() {
      facts.flush()
      return readJournalSqlUsageLimitContinueIdentity(new JournalSqlStatusContext(scope))
    },
    latestContextClearSequence: latestClear,
    echoClaimant(_state, fingerprint, marker5) {
      if (marker5) {
        throw new Error('Legacy reconstruction requires the memory reducer')
      }
      const clear = latestClear()
      const rows = scope.db
        .prepare(`SELECT s.item_key, s.accepted_seq FROM journal_proj_submissions s
        WHERE s.session_id=? AND s.epoch=? AND s.current=1 AND s.fingerprint=?
        AND s.dispatch_state<>'rejected' AND s.write_failure=0 AND s.echo_claimed=0 AND s.item_present=1
        ${clear ? 'AND s.accepted_seq IS NOT NULL' : ''}
        ORDER BY s.submitted_at, s.input_ordinal`)
        .iterate(...scope.prefix, fingerprint)
      for (const row of rows) {
        scope.examined(row)
        if (!clear || Number(row.accepted_seq) > clear) {
          return String(JSON.parse(String(row.item_key)))
        }
      }
      return null
    },
    *itemsAfterSequence(_state, sequence) {
      facts.flush()
      const rows = scope.db
        .prepare(`SELECT entry_key FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND sequence>? ORDER BY ordinal`)
        .all(...scope.prefix, sequence)
      for (const row of rows) {
        scope.examined(row)
        const item = context.read<AgentJournalRenderItem>('items', String(row.entry_key))
        if (item) {
          yield item
        }
      }
    },
    *aliasesForSubmission(_state, itemId) {
      facts.flush()
      const rows = scope.db
        .prepare(`SELECT alias FROM journal_proj_aliases
        WHERE session_id=? AND epoch=? AND target=? ORDER BY ordinal`)
        .all(...scope.prefix, itemId)
      for (const row of rows) {
        scope.examined(row)
        yield String(row.alias)
      }
    },
    candidatesForFence: (_state, fence) => candidateRows('effective_fence', fence),
    candidatesForHandoverFence: (_state, fence) => candidateRows('handover_fence', fence),
    returnedCommandIds: () => journalSqlOrderedValues<string>(context, 'queue.returnedCommands'),
    latestAcceptedUnopened(state) {
      facts.flush()
      const latest = scope.db
        .prepare(`SELECT item_key FROM journal_proj_submissions
        WHERE session_id=? AND epoch=? AND current=1 AND dispatch_state='accepted' AND item_present=1 AND item_unscoped=1
        ORDER BY item_sequence DESC, input_ordinal DESC LIMIT 1`)
        .get(...scope.prefix)
      if (!latest) {
        return false
      }
      scope.examined(latest)
      const itemId = String(JSON.parse(String(latest.item_key)))
      const openers = [itemId, ...this.aliasesForSubmission(state, itemId)]
      for (const opener of openers) {
        const turn = scope.db
          .prepare(`SELECT entry_key FROM journal_proj_items
          WHERE session_id=? AND epoch=? AND opener_item_id=? LIMIT 1`)
          .get(...scope.prefix, opener)
        if (turn) {
          scope.examined(turn)
          return false
        }
      }
      return true
    },
    newestTurnBySequence() {
      facts.flush()
      const row = scope.db
        .prepare(`SELECT entry_key FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND (turn_id IS NOT NULL OR context_clear=1)
        ORDER BY sequence DESC, ordinal DESC LIMIT 1`)
        .get(...scope.prefix)
      if (!row) {
        return null
      }
      scope.examined(row)
      return readAgentJournalTurn(
        context.read<AgentJournalRenderItem>('items', String(row.entry_key))?.body
      )
    },
    latestItemForTurn(_state, turnId) {
      facts.flush()
      const row = scope.db
        .prepare(`SELECT entry_key FROM journal_proj_items
        WHERE session_id=? AND epoch=? AND turn_id=? AND hidden=0
        ORDER BY sequence DESC, sequence_index DESC, ordinal DESC LIMIT 1`)
        .get(...scope.prefix, turnId)
      if (!row) {
        return null
      }
      scope.examined(row)
      return context.read<AgentJournalRenderItem>('items', String(row.entry_key)) ?? null
    },
    oldestAppliedSettlementId: () =>
      journalSqlOrderedValues<string>(context, 'appliedSettlementIds', 1).next().value,
    nativeInputEntries: (state) => memoryJournalMap(state.inputEntries).entries(),
    nativeInputCards: (state) => memoryJournalMap(state.inputCards).entries(),
    queueCardsForInitialization: () =>
      journalSqlOrderedValues<QueuedMessageRow>(context, 'queue.cards')
  }
}
