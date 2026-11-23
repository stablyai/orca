import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { applyJournalSqlMaintenance } from './journal-sql-maintenance'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { JournalSqlBackgroundMaintenance } from './journal-sql-background-maintenance'
import { JournalSqlActivity } from './journal-sql-activity'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'

const IDLE_BEFORE = 10_000
const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo::/workspaces/repo/gone',
  workspaceKind: 'git-worktree'
} as const

const RELEASED_LEASE = agentSessionRecordFixture({ sessionId: 'gone-chat' }).lease

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

function inTransaction<T>(db: Database.Database, run: () => T): T {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = run()
    db.exec('COMMIT')
    return result
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

/** Two chats with tabs and history; `gone` has 70 items over two epochs, more than one page. */
function journal(gone: Partial<AgentSessionRecord> = {}) {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  const records = [
    {
      ...agentSessionRecordFixture({
        sessionId: 'gone-chat',
        createdAt: 5_000,
        location: LOCATION
      }),
      // Every launch's lease reconciliation stamps both; the user did nothing.
      updatedAt: 20_000,
      lease: { ...RELEASED_LEASE, lastRenewedAt: 20_000 },
      ...gone
    },
    agentSessionRecordFixture({ sessionId: 'kept-chat', createdAt: 5_000, location: LOCATION })
  ]
  records.forEach((record, position) => {
    db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)').run(
      record.sessionId,
      JSON.stringify(encodeAgentSessionRecord(record))
    )
    db.prepare('INSERT INTO agent_session_tabs VALUES(?,?,?)').run(
      `tab-${record.sessionId}`,
      record.sessionId,
      position
    )
    db.prepare(`INSERT INTO journal_chat_state(session_id,workspace_id,epoch,last_activity_at)
      VALUES(?,?,'current',5000)`).run(record.sessionId, LOCATION.workspaceId)
  })
  db.prepare("INSERT INTO agent_session_store_meta VALUES('session_tabs_recorded','1')").run()
  db.prepare(
    "INSERT INTO agent_session_store_meta VALUES('journal.legacy-revision:gone-chat','[\"legacy\",3]')"
  ).run()
  const item = db.prepare(`INSERT INTO journal_items(session_id,epoch,item_id,ordinal,revision,
    sequence,sequence_index,owner_fence,payload_json) VALUES(?,?,?,?,1,?,0,1,'{"text":"saved"}')`)
  for (let index = 0; index < 70; index++) {
    item.run('gone-chat', index < 35 ? 'retired' : 'current', `item-${index}`, index, index)
  }
  item.run('kept-chat', 'current', 'item-0', 0, 0)
  db.prepare(`INSERT INTO journal_events VALUES('gone-chat','current',1,100,'{}')`).run()
  db.prepare(`INSERT INTO journal_provider_activity VALUES('gone-chat','current',1,5000)`).run()
  return db
}

function forget(db: Database.Database, location: AgentSessionRecord['location'] = LOCATION) {
  const result = inTransaction(db, () =>
    applyJournalWriterEffect(db, '/state', {
      kind: 'store',
      mutation: {
        input: {
          kind: 'command',
          command: {
            kind: 'forget-idle',
            sessionId: 'gone-chat',
            location,
            idleBefore: IDLE_BEFORE,
            legacyTabIds: []
          }
        }
      }
    })
  )
  return typeof result === 'object' && result !== null && 'value' in result ? result.value : null
}

const count = (db: Database.Database, sql: string): number =>
  Number(db.prepare(`SELECT COUNT(*) AS count FROM ${sql}`).get()?.count)

it('deletes an idle chat with its tab, then every journal row in background pages, keeping its legacy revision', async () => {
  const db = journal()
  expect(forget(db)).toBe(true)
  expect(count(db, "agent_session_records WHERE session_id='gone-chat'")).toBe(0)
  expect(count(db, "agent_session_tabs WHERE session_id='gone-chat'")).toBe(0)

  const maintenance = new JournalSqlBackgroundMaintenance(
    {
      maintain: async (operation) =>
        inTransaction(db, () => applyJournalSqlMaintenance(db, operation))
    },
    { database: async (operation) => readJournalSqlDatabase(db, operation) },
    {
      ensure: async () => null,
      compareLegacyChats: async () => {},
      deferred: () => false,
      resumed: () => false
    },
    new JournalSqlActivity(),
    (error) => {
      throw error
    }
  )
  await maintenance.requestSweep()
  maintenance.stop()

  expect(count(db, "journal_items WHERE session_id='gone-chat'")).toBe(0)
  expect(count(db, "journal_events WHERE session_id='gone-chat'")).toBe(0)
  expect(count(db, "journal_provider_activity WHERE session_id='gone-chat'")).toBe(0)
  expect(count(db, "journal_chat_state WHERE session_id='gone-chat'")).toBe(0)
  expect(count(db, "agent_session_store_meta WHERE key LIKE 'journal.forgotten-chat:%'")).toBe(0)
  expect(
    db
      .prepare(
        "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-revision:gone-chat'"
      )
      .get()?.value
  ).toBe('["legacy",3]')
  expect(count(db, "agent_session_records WHERE session_id='kept-chat'")).toBe(1)
  expect(count(db, "agent_session_tabs WHERE session_id='kept-chat'")).toBe(1)
  expect(count(db, "journal_items WHERE session_id='kept-chat'")).toBe(1)
  expect(count(db, "journal_chat_state WHERE session_id='kept-chat'")).toBe(1)
})

it('takes the revision a chat awaiting its older-Orca compare waited on, so no copy brings it back', () => {
  const db = journal()
  db.prepare(
    `DELETE FROM agent_session_store_meta WHERE key='journal.legacy-revision:gone-chat'`
  ).run()
  db.prepare(
    `INSERT INTO agent_session_store_meta VALUES('journal.legacy-compare:gone-chat','["legacy",4]')`
  ).run()
  expect(forget(db)).toBe(true)
  expect(count(db, "agent_session_store_meta WHERE key LIKE 'journal.legacy-compare:%'")).toBe(0)
  expect(
    db
      .prepare(
        "SELECT value FROM agent_session_store_meta WHERE key='journal.legacy-revision:gone-chat'"
      )
      .get()?.value
  ).toBe('["legacy",4]')
})

it("drops a forgotten copy's mapping and failure, so none of its keys outlive it", () => {
  const db = journal()
  for (const [key, value] of [
    ['journal.legacy-copy-source:gone-chat', 'original-chat'],
    ['journal.legacy-failed:gone-chat', '{"revision":null,"error":"damaged"}'],
    ['journal.legacy-pending-copy:original-chat', 'gone-chat']
  ]) {
    db.prepare('INSERT INTO agent_session_store_meta VALUES(?,?)').run(key, value)
  }
  expect(forget(db)).toBe(true)
  expect(
    count(
      db,
      "agent_session_store_meta WHERE key LIKE 'journal.legacy-copy-source:%' OR key LIKE 'journal.legacy-failed:%' OR key LIKE 'journal.legacy-pending-copy:%'"
    )
  ).toBe(0)
})

const refusals: {
  name: string
  gone?: Partial<AgentSessionRecord>
  arrange?: (db: Database.Database) => void
  location?: AgentSessionRecord['location']
}[] = [
  {
    name: 'an owner reserved it',
    gone: { lease: { ...RELEASED_LEASE, claimStatus: 'reserved', reservedSpawnToken: 'spawn' } }
  },
  {
    name: 'Orca has not reconciled it since launch',
    gone: { lease: { ...RELEASED_LEASE, unreconciled: true } }
  },
  { name: 'it was created since the cutoff', gone: { createdAt: 20_000 } },
  { name: 'a turn ended since the cutoff', gone: { lastTurn: { state: 'settled', at: 20_000 } } },
  {
    name: 'the user sent since the cutoff',
    arrange: (db) =>
      db
        .prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
        attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,payload_json)
        VALUES('gone-chat','current','sent',1,0,1,'item-69',69,20000,'fingerprint','accepted','body')`)
        .run()
  },
  {
    name: 'its /clear continuation is still saved',
    gone: {
      conversationCommand: {
        command: 'clear',
        state: 'completed',
        replacementSessionId: 'kept-chat',
        operationId: 'clear-operation',
        callerKey: 'caller',
        phase: 'committed'
      }
    }
  },
  { name: 'its last turn is still open', gone: { lastTurn: { state: 'open', at: 5_000 } } },
  {
    name: 'the agent ran since the cutoff',
    arrange: (db) =>
      db
        .prepare(`INSERT INTO journal_provider_activity VALUES('gone-chat','current',2,20000)`)
        .run()
  },
  {
    name: 'input waits to be sent',
    arrange: (db) =>
      db
        .prepare(`INSERT INTO journal_submission_attempts(session_id,epoch,message_id,attempt_sequence,
        attempt_index,current,item_id,ordinal,submitted_at,fingerprint,dispatch_state,payload_json)
        VALUES('gone-chat','current','send',1,0,1,'item-69',69,1,'fingerprint','pending','body')`)
        .run()
  },
  {
    name: 'queued text waits to be sent',
    arrange: (db) =>
      db
        .prepare(
          `INSERT INTO journal_queue_cards VALUES('gone-chat','current','queued',1,'waiting',1,NULL,'body')`
        )
        .run()
  },
  {
    name: 'it is recorded somewhere other than where the sweep saw it',
    location: { ...LOCATION, workspaceId: 'repo::/workspaces/repo/live' }
  }
]

it.each(refusals)('keeps a chat when $name', ({ gone, arrange, location }) => {
  const db = journal(gone)
  arrange?.(db)
  expect(forget(db, location)).toBe(false)
  expect(count(db, "agent_session_records WHERE session_id='gone-chat'")).toBe(1)
  expect(count(db, "agent_session_tabs WHERE session_id='gone-chat'")).toBe(1)
  expect(count(db, "agent_session_store_meta WHERE key LIKE 'journal.forgotten-chat:%'")).toBe(0)
})
