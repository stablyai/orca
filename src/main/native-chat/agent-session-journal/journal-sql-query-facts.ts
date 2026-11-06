import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { JournalDispatchRow } from './journal-row-schema'
import type { JournalInputSource } from './journal-input-source-schema'
import type { JournalSqlValueContext } from './journal-sql-value-context'
import { journalSqlEntryKey } from './journal-sql-keyed-values'

/** Refreshes only touched keys; these columns select control facts without loading their bodies. */
export class JournalSqlQueryFacts {
  private readonly pending = new Map<string, [string, string]>()

  constructor(private readonly context: JournalSqlValueContext) {
    context.changed = (collection, key) => {
      if (
        [
          'items',
          'submissions',
          'inputs.echoes',
          'evidence.ordinals',
          'inputs.candidates',
          'inputs.sources',
          'inputs.handovers',
          'inputs.rejections',
          'inputs.presentations'
        ].includes(collection)
      ) {
        this.pending.set(JSON.stringify([collection, key]), [collection, key])
      }
    }
  }

  flush(): void {
    this.context.flush()
    const changes = [...this.pending.values()]
    this.pending.clear()
    for (const [collection, key] of changes) {
      if (collection === 'submissions' || collection === 'evidence.ordinals') {
        this.submission(key)
        if (collection === 'submissions') {
          this.candidate(key)
        }
      } else if (collection === 'inputs.echoes' || collection === 'items') {
        const identity = parseAgentJournalItemKey(String(JSON.parse(key)))
        if (identity?.provider === 'orca') {
          this.submission(journalSqlEntryKey(identity.clientMessageId))
          this.visibility(journalSqlEntryKey(identity.clientMessageId))
        }
      } else if (collection === 'inputs.rejections' || collection === 'inputs.presentations') {
        this.visibility(key)
      } else if (collection.startsWith('inputs.')) {
        this.candidate(key)
      }
    }
  }

  private visibility(key: string): void {
    const { scope } = this.context
    scope.db
      .prepare(`UPDATE journal_proj_items SET hidden=(
      EXISTS(SELECT 1 FROM journal_proj_values WHERE session_id=? AND generation=?
        AND collection='inputs.rejections' AND entry_key=?) AND
      NOT EXISTS(SELECT 1 FROM journal_proj_values WHERE session_id=? AND generation=?
        AND collection='inputs.presentations' AND entry_key=?))
      WHERE session_id=? AND generation=? AND entry_key=?`)
      .run(
        ...scope.prefix,
        key,
        ...scope.prefix,
        key,
        ...scope.prefix,
        journalSqlEntryKey(agentJournalSubmissionKey(String(JSON.parse(key))))
      )
  }

  private submission(key: string): void {
    const { context } = this
    const { scope } = context
    const send = context.read<AgentJournalSubmission>('submissions', key, false)
    if (!send) {
      return
    }
    const itemId = agentJournalSubmissionKey(send.clientMessageId)
    const item = scope.db
      .prepare(`SELECT sequence, turn_item_id FROM journal_proj_items
      WHERE session_id=? AND generation=? AND entry_key=?`)
      .get(...scope.prefix, journalSqlEntryKey(itemId))
    if (item) {
      scope.examined(item)
    }
    const ordinal =
      context.read<number>('evidence.ordinals', key, false) ??
      Number(context.header('submissions', key)?.ordinal)
    scope.db
      .prepare(`UPDATE journal_proj_submissions SET input_ordinal=?, echo_claimed=?, item_present=?,
        item_sequence=?, item_unscoped=? WHERE session_id=? AND epoch=? AND client_message_id=? AND current=1`)
      .run(
        ordinal,
        Number(!!context.header('inputs.echoes', journalSqlEntryKey(itemId))),
        Number(!!item),
        Number(item?.sequence ?? 0),
        Number(!item?.turn_item_id),
        ...scope.prefix,
        String(JSON.parse(key))
      )
  }

  private candidate(key: string): void {
    const { context } = this
    const { scope } = context
    const send = context.read<AgentJournalSubmission>('inputs.candidates', key, false)
    if (!send) {
      scope.db
        .prepare(`DELETE FROM journal_proj_input_candidates
        WHERE session_id=? AND generation=? AND entry_key=?`)
        .run(...scope.prefix, key)
      return
    }
    const handover = context.read<JournalDispatchRow>('inputs.handovers', key, false)
    const source = context.read<JournalInputSource>('inputs.sources', key, false)
    scope.db
      .prepare(`INSERT INTO journal_proj_input_candidates
      (session_id, generation, entry_key, ordinal, effective_fence, handover_fence)
      VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id, generation, entry_key)
      DO UPDATE SET ordinal=excluded.ordinal, effective_fence=excluded.effective_fence,
      handover_fence=excluded.handover_fence`)
      .run(
        ...scope.prefix,
        key,
        Number(context.header('inputs.candidates', key)?.ordinal),
        handover?.fence ?? source?.fence ?? send.fence,
        handover?.fence ?? null
      )
  }
}
