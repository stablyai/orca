import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { JournalStateQueries } from './journal-state-queries'
import type { JournalInputEntry, JournalInputCard } from './journal-input-lineage'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import type { JournalSqlQueryFacts } from './journal-sql-query-facts'
import {
  journalSqlEntryKey,
  journalSqlOrderedKeys,
  journalSqlOrderedValues
} from './journal-sql-keyed-values'
import type { QueuedMessageRow } from './queued-message-table'

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
      .prepare(`SELECT entry_key FROM journal_proj_input_candidates
      WHERE session_id=? AND generation=? AND ${column}=? ORDER BY ordinal`)
      .all(...scope.prefix, fence)
      .map((row) => {
        scope.examined(row)
        return context.read<AgentJournalSubmission>('inputs.candidates', String(row.entry_key))!
      })
  }
  const latestClear = (): number => {
    facts.flush()
    const row = scope.db
      .prepare(`SELECT sequence FROM journal_proj_items
      WHERE session_id=? AND generation=? AND context_clear=1 ORDER BY sequence DESC LIMIT 1`)
      .get(...scope.prefix)
    if (row) {
      scope.examined(row)
    }
    return Number(row?.sequence ?? 0)
  }
  function* entries<V>(collection: string): Generator<[string, V]> {
    facts.flush()
    for (const key of journalSqlOrderedKeys(context, collection)) {
      yield [String(JSON.parse(key)), context.read<V>(collection, key)!]
    }
  }
  return {
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
        WHERE session_id=? AND generation=? AND sequence>? ORDER BY ordinal`)
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
        .prepare(`SELECT entry_key FROM journal_proj_aliases
        WHERE session_id=? AND generation=? AND target_key=? ORDER BY ordinal`)
        .all(...scope.prefix, journalSqlEntryKey(itemId))
      for (const row of rows) {
        scope.examined(row)
        yield String(JSON.parse(String(row.entry_key)))
      }
    },
    candidatesForFence: (_state, fence) => candidateRows('effective_fence', fence),
    candidatesForHandoverFence: (_state, fence) => candidateRows('handover_fence', fence),
    returnedCommandIds: () => journalSqlOrderedValues<string>(context, 'queue.returnedCommands'),
    legacyInputEntryCount() {
      facts.flush()
      const row = scope.db
        .prepare(`SELECT COUNT(*) AS count FROM journal_proj_native_entries
        WHERE session_id=? AND generation=? AND basis='legacy'`)
        .get(...scope.prefix)!
      scope.work.rows += Number(row.count)
      return Number(row.count)
    },
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
          WHERE session_id=? AND generation=? AND opener_item_id=? LIMIT 1`)
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
        WHERE session_id=? AND generation=? AND (turn_id IS NOT NULL OR context_clear=1)
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
    oldestAppliedSettlementId: () =>
      journalSqlOrderedValues<string>(context, 'appliedSettlementIds', 1).next().value,
    nativeInputEntries: () => entries<JournalInputEntry>('inputEntries'),
    nativeInputCards: () => entries<JournalInputCard>('inputCards'),
    queueCardsForInitialization: () =>
      journalSqlOrderedValues<QueuedMessageRow>(context, 'queue.cards')
  }
}
