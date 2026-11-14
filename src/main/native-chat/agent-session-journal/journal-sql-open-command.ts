import type Database from '../../sqlite/sync-database'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { JournalWriterCommand } from './journal-writer-command'
import { applyJournalSqlEditLeaseCommand } from './journal-sql-edit-lease-command'
import { applyJournalDomainInputRecovery } from './journal-domain-input-recovery'
import { applyJournalDomainControlCommand } from './journal-domain-control-command'
import { journalDomainQueueAwaitsReopen } from './journal-domain-queue-reads'
import { finishJournalSqlCommand } from './journal-sql-command-result'
import { checkpointJournalRequestEvents } from './journal-writer-request-events'
import { journalSqlFailure, type JournalSqlFailure } from './journal-sql-failure'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session/journal/agent-session-journal-types'
import { staleSubagentRosterRevisions } from './item-lifecycle/journal-subagent-liveness'
import { applyJournalDomainLifecycle } from './journal-domain-lifecycle'
import { withdrawOpeningDerivedQueue } from './journal-open-queue-withdrawal'

export type JournalOpenRecoveryResult = {
  failures: {
    step: 'pending-unknown' | 'hold-unsent' | 'withdraw-derived' | 'queue-reopen'
    failure: JournalSqlFailure
  }[]
  reopenFloor: AgentJournalCursor | null
}

/** Opening recovers journal-only obligations at the same writer position, before any reader. */
export function applyJournalSqlOpenCommand(
  db: Database.Database,
  stateDirectory: string,
  command: JournalWriterCommand & {
    operation: Extract<JournalWriterCommand['operation'], { kind: 'open' }>
  },
  savedAt: number
) {
  const opened = applyJournalSqlEditLeaseCommand(db, stateDirectory, command, savedAt)
  const { recover } = command.operation
  const { target } = command
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: open returns its physical pre-recovery cursor.
  const openedThrough = opened.value as AgentJournalCursor
  const fence =
    recover?.fence ??
    Number(
      db
        .prepare('SELECT highest_fence FROM journal_chat_state WHERE session_id=? AND epoch=?')
        .get(target.sessionId, target.epoch)!.highest_fence
    )
  settleOpeningLiveWork(db, target, savedAt)
  const recovery: JournalOpenRecoveryResult = { failures: [], reopenFloor: null }
  const attempt = <Value>(
    step: JournalOpenRecoveryResult['failures'][number]['step'],
    run: () => Value
  ) => {
    const restoreEvents = checkpointJournalRequestEvents(db)
    db.exec('SAVEPOINT journal_open_recovery')
    try {
      const value = run()
      db.exec('RELEASE journal_open_recovery')
      return value
    } catch (error) {
      db.exec('ROLLBACK TO journal_open_recovery; RELEASE journal_open_recovery')
      restoreEvents()
      recovery.failures.push({ step, failure: journalSqlFailure(error) })
      return undefined
    }
  }
  for (const kind of recover
    ? (['pending-unknown', 'hold-unsent'] as const)
    : (['hold-unsent'] as const)) {
    const result = attempt(kind, () =>
      applyJournalDomainInputRecovery(
        db,
        target,
        kind === 'pending-unknown'
          ? { kind, fence }
          : { kind, fence, hold: { cause: 'hostRestarted' } },
        { openedThrough },
        savedAt
      )
    )
    if (result && 'failure' in result.value) {
      recovery.failures.push({ step: kind, failure: result.value.failure })
    }
  }
  attempt('withdraw-derived', () =>
    withdrawOpeningDerivedQueue(db, stateDirectory, target, openedThrough, savedAt)
  )
  if (recover) {
    attempt('queue-reopen', () => {
      if (journalDomainQueueAwaitsReopen(db, target)) {
        const head = db
          .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
          .get(target.sessionId, target.epoch)!
        recovery.reopenFloor = { epoch: target.epoch, sequence: Number(head.last_sequence) + 1 }
        applyJournalDomainControlCommand(
          db,
          target,
          { kind: 'queue-reopen-mark', fence },
          {},
          savedAt
        )
        recovery.reopenFloor = null
      }
    })
  }
  const head = db
    .prepare('SELECT last_sequence FROM journal_chat_state WHERE session_id=? AND epoch=?')
    .get(target.sessionId, target.epoch)!
  const sequence = Number(head.last_sequence)
  return {
    ...finishJournalSqlCommand(
      db,
      stateDirectory,
      command,
      {
        cursor: { epoch: target.epoch, sequence },
        inputChanged: opened.inputChanged || sequence !== openedThrough.sequence,
        items: [],
        cards: [],
        receipts: [],
        editDeadline: opened.publication?.editDeadline
      },
      openedThrough,
      []
    ),
    openRecovery: recovery
  }
}

function settleOpeningLiveWork(
  db: Database.Database,
  target: { sessionId: string; epoch: string },
  savedAt: number
): void {
  let after: [number, string] | undefined
  for (;;) {
    const rows = db
      .prepare(`SELECT ordinal,item_id,payload_json FROM journal_items
      INDEXED BY journal_items_unsettled WHERE session_id=? AND epoch=? AND hidden=0
      AND (lifecycle_state IN ('running','pending') OR live_work=1) AND live_work=1
      ${after ? 'AND (ordinal,item_id)>(?,?)' : ''} ORDER BY ordinal,item_id LIMIT 128`)
      .all(target.sessionId, target.epoch, ...(after ?? []))
    const items: AgentJournalRenderItem[] = rows.map((row) => JSON.parse(String(row.payload_json)))
    const revisions = staleSubagentRosterRevisions(items)
    if (revisions.length > 0) {
      const head = db
        .prepare(`SELECT last_sequence,highest_fence FROM journal_chat_state
        WHERE session_id=? AND epoch=?`)
        .get(target.sessionId, target.epoch)!
      applyJournalDomainLifecycle(
        db,
        target,
        {
          settlementId: `open-live-work:${Number(head.last_sequence)}`,
          fence: Number(head.highest_fence),
          recovered: true,
          mutations: revisions.map((revision) => ({
            ...revision,
            kind: 'item',
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          }))
        },
        savedAt
      )
    }
    if (rows.length < 128) {
      return
    }
    const last = rows.at(-1)!
    after = [Number(last.ordinal), String(last.item_id)]
  }
}
