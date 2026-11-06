import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { advanceJournalOutcomeSource } from './journal-outcome-format'
import { JournalProjectionStaleError } from './journal-sql-meta'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const roster = {
  provider: 'orca',
  clientMessageId: 'codex-subagents:group'
} as const

function fixture() {
  const db = new Database(':memory:')
  databases.push(db)
  seedJournalSqlCommands(db)
  const engine = new JournalSqlCommand(db, '/unused')
  const batch = new JournalSqlBatch(db)
  const run = async (ownerToken: string, operation: JournalWriterOperation) => {
    const command: JournalWriterCommand = {
      target: { sessionId: 'session', epoch: 'epoch', ownerToken },
      operation
    }
    const [outcome] = (
      await batch.run([{ command, normal: false }], (entry) => engine.apply(entry, 100))
    ).outcomes
    if (!outcome!.committed) {
      throw outcome!.error
    }
    return outcome!.value
  }
  return { db, run }
}

it('opens a converted chat from its projection and settles live work the last host left', async () => {
  const { db, run } = fixture()
  await run('open-token', {
    kind: 'item',
    identity: roster,
    body: {
      kind: 'message',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: 'group',
          agents: [{ id: 'a', label: 'read', state: 'working', startedAt: 10 }]
        }
      ]
    },
    options: { fence: 1, turnScope: { kind: 'thread' } }
  })

  const opened = await run('next-handle', { kind: 'open' })

  expect(opened.value).toEqual({ epoch: 'epoch', sequence: 3 })
  expect(db.prepare('SELECT owner_token FROM journal_proj_meta').get()?.owner_token).toBe(
    'next-handle'
  )
  const items = new JournalSqlReducer(new JournalSqlScope(db, 'session', 'epoch'), 'epoch').state
    .items
  const settled = items.get(agentJournalItemKey(roster))
  expect(settled?.recovered).toBe(true)
  expect(settled?.body).toMatchObject({
    blocks: [{ agents: [{ id: 'a', state: 'unverifiable' }] }]
  })
  await expect(run('open-token', { kind: 'queue-resume', fence: 1 })).rejects.toMatchObject({
    code: 'journal_closed'
  })
})

it('reconverts after an older build writes the log or removes legacy cards', async () => {
  const outcome = fixture()
  advanceJournalOutcomeSource(outcome.db, 'session', 'epoch', 2)
  await expect(outcome.run('next-handle', { kind: 'open' })).rejects.toBeInstanceOf(
    JournalProjectionStaleError
  )

  const raw = fixture()
  raw.db
    .prepare(
      'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
    )
    .run('session', 'epoch', 9, 100, '{}')
  await expect(raw.run('next-handle', { kind: 'open' })).rejects.toBeInstanceOf(
    JournalProjectionStaleError
  )

  const legacy = fixture()
  legacy.db
    .prepare(`INSERT INTO queued_messages (session_id, message_id, position, body_json,
      fingerprint, created_at, host_instance, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run('session', 'card', 0, '{}', 'fingerprint', 100, 'host', 'waiting')
  await expect(legacy.run('next-handle', { kind: 'open' })).rejects.toBeInstanceOf(
    JournalProjectionStaleError
  )
})
