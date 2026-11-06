import type { AgentJournalSubmission } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentJournalSubmissionKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { isWriteFailureSubmission } from '../../../shared/agent-session/requests/structured-agent-session-dispatch-rejection'
import type { JournalDispatchRow } from './journal-row-schema'
import type { JournalInputSource } from './journal-input-source-schema'
import type { JournalInputEntry } from './journal-input-lineage'
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
          'inputs.presentations',
          'aliases',
          'inputEntries'
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
      } else if (collection === 'aliases') {
        this.alias(key)
      } else {
        this.nativeEntry(key)
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
      scope.db
        .prepare(`DELETE FROM journal_proj_submissions
        WHERE session_id=? AND generation=? AND entry_key=?`)
        .run(...scope.prefix, key)
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
      .prepare(`INSERT INTO journal_proj_submissions
      (session_id, generation, entry_key, item_key, input_ordinal, fingerprint, submitted_at,
       accepted_seq, dispatch_state, write_failure, echo_claimed, item_present, item_sequence, item_unscoped)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id, generation, entry_key) DO UPDATE SET
      item_key=excluded.item_key, input_ordinal=excluded.input_ordinal,
      fingerprint=excluded.fingerprint, submitted_at=excluded.submitted_at,
      accepted_seq=excluded.accepted_seq, dispatch_state=excluded.dispatch_state,
      write_failure=excluded.write_failure, echo_claimed=excluded.echo_claimed,
      item_present=excluded.item_present, item_sequence=excluded.item_sequence, item_unscoped=excluded.item_unscoped`)
      .run(
        ...scope.prefix,
        key,
        journalSqlEntryKey(itemId),
        ordinal,
        send.payloadFingerprint ?? null,
        send.submittedAt,
        send.acceptedSequence ?? null,
        send.dispatchState,
        Number(isWriteFailureSubmission(send)),
        Number(!!context.header('inputs.echoes', journalSqlEntryKey(itemId))),
        Number(!!item),
        Number(item?.sequence ?? 0),
        Number(!item?.turn_item_id)
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

  private alias(key: string): void {
    const { context } = this
    const { scope } = context
    const value = context.read<string>('aliases', key, false)
    if (value === undefined) {
      scope.db
        .prepare(`DELETE FROM journal_proj_aliases
        WHERE session_id=? AND generation=? AND entry_key=?`)
        .run(...scope.prefix, key)
      return
    }
    scope.db
      .prepare(`INSERT INTO journal_proj_aliases
      (session_id, generation, entry_key, target_key, ordinal) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, generation, entry_key) DO UPDATE SET
      target_key=excluded.target_key, ordinal=excluded.ordinal`)
      .run(
        ...scope.prefix,
        key,
        journalSqlEntryKey(value),
        Number(context.header('aliases', key)?.ordinal)
      )
  }

  private nativeEntry(key: string): void {
    const { context } = this
    const { scope } = context
    const entry = context.read<JournalInputEntry>('inputEntries', key, false)
    if (!entry) {
      scope.db
        .prepare(`DELETE FROM journal_proj_native_entries
        WHERE session_id=? AND generation=? AND entry_key=?`)
        .run(...scope.prefix, key)
      return
    }
    scope.db
      .prepare(`INSERT INTO journal_proj_native_entries
      (session_id, generation, entry_key, basis) VALUES (?, ?, ?, ?)
      ON CONFLICT(session_id, generation, entry_key) DO UPDATE SET basis=excluded.basis`)
      .run(...scope.prefix, key, entry.context.basis)
  }
}
