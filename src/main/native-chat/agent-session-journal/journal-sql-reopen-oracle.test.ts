import { cpSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { JournalReducerState } from './journal-reducer'
import {
  closeTestJournalHostDatabase,
  closeTestJournalHostDatabases,
  openTestJournalHostDatabase,
  publishTestJournalEpoch
} from './journal-host-database-test-support'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import { beginJournalSqlConversion, markJournalSqlReady } from './journal-sql-meta'
import { journalInputOrder } from './journal-input-order'
import { persistJournalOutcomeTransition } from './journal-outcome-table'
import { advanceJournalOutcomeSource, startJournalOutcomeLog } from './journal-outcome-format'
import { openAgentSessionJournal } from './journal-store-factory'
import { memoryJournalMap } from './journal-memory-collections'
import { journalSqlLifecycleRows } from './journal-sql-reducer-rows.test-fixture'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'

const roots: string[] = []
afterEach(async () => {
  await closeTestJournalHostDatabases()
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

const identity = {
  sessionId: 'session',
  workspaceId: 'ws-1',
  hostId: 'host',
  agent: 'codex' as const,
  providerHandle: codexProviderHandle('thread')
}

function answers(state: JournalReducerState) {
  const order = journalInputOrder(state)
  order.cards.ensure(state)
  return {
    firstQueued: order.firstQueued()?.clientMessageId,
    explicit: order.explicitSend()?.clientMessageId,
    entered: [...order.enteredSubmissions()].map((send) => send.clientMessageId),
    unsettled: order.unsettledSubmissions().map((send) => send.clientMessageId),
    sending: order.sendingSubmissions().map((send) => send.clientMessageId),
    stopped: order.stoppedHistoryInputs('send').map((send) => send.clientMessageId),
    inputs: ['send', 'second', 'first', 'retry'].map((id) => ({
      id,
      predecessors: order.predecessors(state, id),
      original: order.familyOriginal(id)?.clientMessageId,
      linked: [...order.linkedTo(id)].map((send) => send.clientMessageId),
      ended: state.inputs.ended.has(id)
    })),
    cards: ['q', 'command', 'ordinary', 'foreign'].map((id) => {
      const card = state.queue.cards.get(id)
      return [id, card ? order.paused(state, card, null) : null]
    }),
    head: order.head(state, null)?.messageId ?? null,
    bounds: order.cardBounds(state),
    newest: state.queries.newestTurnBySequence(state),
    clear: state.queries.latestContextClearSequence(state),
    echo: state.queries.echoClaimant(state, 'fp', false),
    unopened: state.queries.latestAcceptedUnopened(state),
    candidates: state.queries.candidatesForFence(state, 1).map((send) => send.clientMessageId),
    handovers: [...state.queries.candidatesForHandoverFence(state, 1)].map(
      (send) => send.clientMessageId
    ),
    returned: [...state.queries.returnedCommandIds(state)],
    secondEnded: state.inputs.ended.has('second'),
    newestFailure: order.newestTurn.failure()
  }
}

/**
 * Runtime input views a restore re-derives from retained admissions; a persisted chat keeps the
 * values it had before it closed (plan §35.1, listed differences).
 */
function reopenAnswers(state: JournalReducerState) {
  const {
    candidates: _c,
    handovers: _h,
    echo: _e,
    secondEnded: _s,
    inputs,
    ...rest
  } = answers(state)
  return { ...rest, inputs: inputs.map(({ ended: _ended, ...input }) => input) }
}

it.each([
  { name: 'lifecycle and rollback', rows: journalSqlLifecycleRows() },
  { name: 'native queue and retry families', rows: journalSqlRetryRows(false) },
  { name: 'legacy queue and retry families', rows: journalSqlRetryRows(true) }
])('reopens a persisted chat as main reopens its saved log: $name', async ({ rows }) => {
  const root = await mkdtemp(join(tmpdir(), 'orca-journal-reopen-'))
  roots.push(root)
  const finish = (state: JournalReducerState) => journalInputOrder(state).cards.ensure(state)
  for (const [index, row] of rows.entries()) {
    const database = openTestJournalHostDatabase(root)
    database.transaction((db) => {
      if (index === 0) {
        publishTestJournalEpoch(db, 'session', 'epoch')
        db.exec(journalSqlProjectionSchema())
        startJournalOutcomeLog(db, 'session', 'epoch', 0, 100)
        beginJournalSqlConversion(db, 'session')
      }
      const generation = Number(
        db
          .prepare('SELECT generation FROM journal_outcome_epochs WHERE session_id=? AND epoch=?')
          .get('session', 'epoch')!.generation
      )
      const sql = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch')
      persistJournalOutcomeTransition(
        db,
        sql.transition(),
        { generation, prefix: 0 },
        [row],
        row.ts,
        false,
        finish
      )
      advanceJournalOutcomeSource(db, 'session', 'epoch', row.seq)
      markJournalSqlReady(db, 'session')
    })
    await closeTestJournalHostDatabase(root)
    const copy = `${root}-main-${index}`
    roots.push(copy)
    cpSync(root, copy, { recursive: true })
    const main = await openAgentSessionJournal({
      identity,
      database: openTestJournalHostDatabase(copy)
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the oracle reads main's restored state directly.
    const restored = (main as unknown as { state: JournalReducerState }).state
    const persisted = openTestJournalHostDatabase(root)
    const engine = new JournalSqlCommand(persisted.db, root)
    const [opened] = (
      await new JournalSqlBatch(persisted.db).run(
        [
          {
            command: {
              target: { sessionId: 'session', epoch: 'epoch', ownerToken: `open-${index}` },
              operation: { kind: 'open' as const },
              facts: { identity }
            },
            normal: false
          }
        ],
        (entry) => engine.apply(entry, 100)
      )
    ).outcomes
    expect(opened!.committed, `open after ${row.seq}`).toBe(true)
    const reopened = new JournalSqlReducer(
      new JournalSqlScope(persisted.db, 'session', 'epoch'),
      'epoch'
    ).state
    expect(reopenAnswers(reopened), `answers after ${row.seq}`).toEqual(reopenAnswers(restored))
    expect(reopened.items.size).toBe(restored.items.size)
    for (const [key, item] of memoryJournalMap(restored.items)) {
      expect(reopened.items.get(key), `${key} after ${row.seq}`).toEqual(item)
    }
    await main.close()
    await closeTestJournalHostDatabase(copy)
  }
})
