import { afterEach, expect, it } from 'vitest'
import Database from '../../sqlite/sync-database'
import { migrateJournalDomainSchema } from './journal-domain-schema'
import { applyJournalWriterEffect } from './journal-writer-effects'
import { readJournalSqlDatabase } from './journal-sql-database-read'
import { encodeAgentSessionRecord } from '../../../shared/agent-session/lifecycle/records/agent-session-record-stored-form'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { agentSessionRecordFixture } from '../testing/agent-session-record-test-fixture'

const CHAT = {
  chatId: 'root-chat',
  sessionIds: ['root-chat', 'next-chat'],
  conversations: [{ provider: 'claude', providerSessionId: 'conv-1' }]
}

const LOCATION = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'repo::/workspaces/repo/main',
  workspaceKind: 'git-worktree'
} as const

const databases: Database.Database[] = []
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
})

/** A chat cleared once: `root-chat` committed a /clear into `next-chat`. */
function journal(next: Partial<AgentSessionRecord> = {}) {
  const db = new Database(':memory:')
  databases.push(db)
  migrateJournalDomainSchema(db)
  const records = [
    agentSessionRecordFixture({
      sessionId: 'root-chat',
      createdAt: 5_000,
      updatedAt: 5_000,
      location: LOCATION,
      conversationCommand: {
        command: 'clear',
        runtimeFence: 1,
        operationId: 'op-clear',
        callerKey: 'renderer',
        phase: 'committed',
        state: 'completed',
        replacementSessionId: 'next-chat'
      }
    }),
    {
      ...agentSessionRecordFixture({
        sessionId: 'next-chat',
        createdAt: 6_000,
        updatedAt: 6_000,
        location: LOCATION
      }),
      ...next
    }
  ]
  for (const record of records) {
    db.prepare('INSERT INTO agent_session_records(session_id,record_json) VALUES(?,?)').run(
      record.sessionId,
      JSON.stringify(encodeAgentSessionRecord(record))
    )
  }
  return db
}

function forget(db: Database.Database, sessionIds: string[]) {
  const chat = { ...CHAT, sessionIds }
  db.exec('BEGIN IMMEDIATE')
  const result = applyJournalWriterEffect(db, '/state', {
    kind: 'store',
    mutation: {
      input: {
        kind: 'command',
        command: { kind: 'forget-chat', ...chat, legacyTabIds: [] }
      }
    }
  })
  db.exec('COMMIT')
  return typeof result === 'object' && result !== null && 'value' in result ? result.value : null
}

const records = (db: Database.Database) =>
  db
    .prepare('SELECT session_id FROM agent_session_records ORDER BY session_id')
    .all()
    .map((row) => row.session_id)

const tombstones = (db: Database.Database) => readJournalSqlDatabase(db, { kind: 'deleted-chats' })

it('forgets the whole lineage and writes its tombstone in one commit', () => {
  const db = journal()

  expect(forget(db, ['root-chat', 'next-chat'])).toBe(true)

  expect(records(db)).toEqual([])
  expect(tombstones(db)).toEqual({ kind: 'deleted-chats', chats: [CHAT] })
})

it('refuses part of a lineage whose /clear successor would stay, changing nothing', () => {
  const db = journal()

  expect(forget(db, ['root-chat'])).toBe(false)

  expect(records(db)).toEqual(['next-chat', 'root-chat'])
  expect(tombstones(db)).toEqual({ kind: 'deleted-chats', chats: [] })
})

it('deletes a chat whose turn a quit cut off, its saved turn still open', () => {
  const db = journal({ lastTurn: { state: 'open', at: 1, prompt: 'hi' } })

  expect(forget(db, ['root-chat', 'next-chat'])).toBe(true)

  expect(records(db)).toEqual([])
  expect(tombstones(db)).toEqual({ kind: 'deleted-chats', chats: [CHAT] })
})
