import { afterEach, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { messageFixture, target } from './journal-sql-message.test-fixture'
import { applyJournalDomainItem } from './journal-domain-item'
import {
  readJournalDomainQueuePauseContext,
  writeJournalDomainQueueReopenMark
} from './journal-domain-queue-pauses'
import { readJournalDomainTurnScope } from './journal-domain-turn-scope'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { readJournalSqlQueue } from './journal-sql-queued-messages'
import { JournalSqlScope } from './journal-sql-scope'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function fixture() {
  const result = messageFixture()
  databases.push(result.db)
  const append = async (id: string, body: AgentJournalItemBody, turnItemId?: string) => {
    const resultOfWrite = await result.batch.run([body], () =>
      applyJournalDomainItem(
        result.db,
        target,
        {
          kind: 'item',
          identity: { provider: 'orca', clientMessageId: id },
          body,
          options: {
            fence: 1,
            turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
          }
        },
        100
      )
    )
    expect(resultOfWrite.outcomes[0]?.committed).toBe(true)
  }
  return {
    ...result,
    append,
    context: (ids: readonly string[] = []) =>
      readJournalDomainQueuePauseContext(result.db, target, null, ids)
  }
}

it('holds a failed command only with agent evidence, and Resume must follow its first failure', async () => {
  const { db, append, context } = fixture()
  await append('command-turn:send', {
    kind: 'turn',
    turnId: 'compact:send',
    state: 'completed',
    outcome: 'failure'
  })
  expect(context().pauses).toEqual([])
  await append(
    'agent-error',
    { kind: 'status', text: 'Agent failed', tone: 'error' },
    'orca:command-turn%3Asend'
  )
  expect(context().pauses).toEqual([{ reason: 'failed', since: { epoch: 'epoch', sequence: 12 } }])
  expect(
    readJournalSqlQueue(new JournalSqlScope(db, 'chat', 'epoch'), {
      kind: 'failure-holds',
      facts: { reopenFloor: null }
    })
  ).toEqual({ kind: 'failure-holds', held: true })
  db.prepare('UPDATE journal_chat_state SET queue_resumed_sequence=12').run()
  expect(context().pauses).toEqual([{ reason: 'failed', since: { epoch: 'epoch', sequence: 12 } }])
  await append('command-turn:send', {
    kind: 'turn',
    turnId: 'compact:send',
    state: 'completed',
    outcome: 'failure'
  })
  db.prepare('UPDATE journal_chat_state SET queue_resumed_sequence=13').run()
  expect(context().pauses).toEqual([])
  await append(
    'agent-error',
    { kind: 'status', text: 'Recovered', tone: 'info' },
    'orca:command-turn%3Asend'
  )
  db.prepare('UPDATE journal_chat_state SET queue_resumed_sequence=0').run()
  expect(context().pauses).toEqual([])
})

it('reads exact clear membership, clamps reopen, and derives scope from the owning current epoch', async () => {
  const { db, append, context } = fixture()
  await append('turn', { kind: 'turn', turnId: 'provider-turn', state: 'running' })
  const body = { kind: 'message' as const, role: 'user' as const, blocks: [] }
  expect(readJournalDomainTurnScope(db, target, body)).toEqual({
    kind: 'turn',
    turnItemId: 'orca:turn'
  })
  await append('turn', { kind: 'turn', turnId: 'provider-turn', state: 'completed' })
  expect(readJournalDomainTurnScope(db, target, body)).toEqual({ kind: 'thread' })
  db.exec(`UPDATE journal_chat_state SET queue_clear_sequence=12, queue_clear_operation_id='clear';
    INSERT INTO journal_queue_clear_members VALUES('chat','epoch','one');
    INSERT INTO journal_queue_clear_members VALUES('chat','retired','two')`)
  expect([...context(['one', 'two']).clearMembers]).toEqual(['one'])
  expect([...context(['two']).clearMembers]).toEqual([])
  db.exec('BEGIN')
  writeJournalDomainQueueReopenMark(db, target, 13, 9)
  writeJournalDomainQueueReopenMark(db, target, 14, 4)
  writeJournalDomainQueueReopenMark(db, target, 15, 100)
  db.exec('COMMIT')
  expect(context().marks.reopenedSequence).toBe(15)
  expect(() => readJournalDomainTurnScope(db, { ...target, epoch: 'retired' }, body)).toThrow(
    /retired/
  )
})
