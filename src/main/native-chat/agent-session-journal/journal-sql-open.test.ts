import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { seedJournalSqlCommands } from './journal-sql-command.test-fixture'
import { JournalSqlCommand } from './journal-sql-command'
import { JournalSqlBatch } from './journal-sql-batch'
import { JournalSqlReducer } from './journal-sql-reducer'
import { JournalSqlScope } from './journal-sql-scope'
import { advanceJournalOutcomeSource } from './outcomes/journal-outcome-format'
import { currentJournalSqlEpoch, JournalProjectionStaleError } from './journal-sql-meta'
import type { JournalWriterCommand, JournalWriterOperation } from './journal-writer-command'
import type { AgentSessionJournalIdentity } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import { readJournalSessionEpoch } from './durable-rows/journal-row-table'

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

const identity: AgentSessionJournalIdentity = {
  sessionId: 'session',
  workspaceId: 'workspace',
  hostId: 'host',
  agent: 'codex',
  providerHandle: codexProviderHandle('thread')
}

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
  const run = async (
    ownerToken: string,
    operation: JournalWriterOperation,
    epoch = 'epoch',
    sessionId = 'session'
  ) => {
    const command: JournalWriterCommand = {
      target: { sessionId, epoch, ownerToken },
      operation,
      facts: { identity: { ...identity, sessionId } }
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

it('founds a chat with nothing saved on its first open, owned by that open', async () => {
  const { db, run } = fixture()
  const opened = await run('first-handle', { kind: 'open' }, '', 'fresh')
  const epoch = readJournalSessionEpoch(db, 'fresh')!

  expect(opened.value).toEqual({ epoch, sequence: 1 })
  expect(currentJournalSqlEpoch(db, 'fresh')).toBe(epoch)
  const resumed = await run('first-handle', { kind: 'queue-resume', fence: 1 }, epoch, 'fresh')
  expect(resumed.cursor.sequence).toBe(2)
  await expect(
    run('other-handle', { kind: 'queue-resume', fence: 1 }, epoch, 'fresh')
  ).rejects.toMatchObject({ code: 'journal_closed' })
})
