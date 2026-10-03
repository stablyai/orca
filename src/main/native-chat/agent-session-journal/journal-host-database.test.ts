// The one connection every chat's writes share: its transactions, its busy handling, and the order
// in which it closes at quit.

import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session-journal-types'
import { spawnProcess } from '../../../shared/child-process/run-process'
import { tearDownRuntime } from '../../runtime/structured-agent-session-runtime-teardown'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import type Database from '../../sqlite/sync-database'

const IDENTITY: AgentSessionJournalIdentity = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'local',
  agent: 'codex',
  providerHandle: { kind: 'codex', threadId: 'thread-1' }
}

const OTHER: AgentSessionJournalIdentity = {
  ...IDENTITY,
  sessionId: 'session-2',
  providerHandle: { kind: 'codex', threadId: 'thread-2' }
}

const SUBMISSION = {
  clientMessageId: 'msg-1',
  payloadFingerprint: 'e'.repeat(64),
  body: {
    kind: 'message' as const,
    role: 'user' as const,
    blocks: [{ type: 'text' as const, text: 'hi' }]
  },
  fence: 1
}

let root: string
const journals = createTrackedJournalOpener()

function item(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

/** The next row insert breaks a deferred foreign key, so its transaction's COMMIT fails and SQLite
 *  leaves the transaction open, as it may for a COMMIT that fails on its own. */
function failCommits(db: Database.Database): () => void {
  db.exec(`CREATE TEMP TABLE commit_probe_parent (id INTEGER PRIMARY KEY);
CREATE TEMP TABLE commit_probe_child (
  parent INTEGER REFERENCES commit_probe_parent (id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TEMP TRIGGER commit_probe AFTER INSERT ON main.journal_rows
BEGIN INSERT INTO commit_probe_child (parent) VALUES (1); END`)
  return () => db.exec('DROP TRIGGER temp.commit_probe')
}

function text(value: string) {
  return {
    kind: 'message' as const,
    role: 'assistant' as const,
    blocks: [{ type: 'text' as const, text: value }]
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-host-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

describe('the shared connection', () => {
  // T8: another connection holding the write lock makes an append wait, not fail.
  it('waits out another writer instead of failing the append', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const holder = spawnProcess({
      program: process.execPath,
      args: [
        '-e',
        `const { DatabaseSync } = require('node:sqlite')
const db = new DatabaseSync(process.argv[1])
db.exec('BEGIN IMMEDIATE')
process.stdout.write('holding')
setTimeout(() => { db.exec('COMMIT'); db.close() }, 200)`,
        journalDatabasePath(root)
      ],
      timeoutMs: 30_000
    })
    const exited = new Promise<number | null>((resolve) => holder.once('exit', resolve))
    await new Promise<void>((resolve) => holder.stdout.once('data', () => resolve()))

    await expect(
      journal.appendItem(item(1), text('after the wait'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).resolves.toBeDefined()
    expect(await exited).toBe(0)
  })

  // The #22993 companion: a transaction that cannot begin fails that write alone.
  it('fails only the write whose transaction could not begin', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const exec = database.db.exec.bind(database.db)
    const busy = Object.assign(new Error('database is locked'), {
      code: 'ERR_SQLITE_ERROR',
      errcode: 5
    })
    vi.spyOn(database.db, 'exec').mockImplementationOnce(() => {
      throw busy
    })

    await expect(
      journal.appendItem(item(1), text('refused'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).rejects.toBe(busy)
    vi.mocked(database.db.exec).mockImplementation(exec)
    await expect(
      journal.appendItem(item(2), text('next'), { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).resolves.toBeDefined()
    expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([text('next')])
  })

  it('frees the connection after a failed COMMIT: nothing adopted, published or acknowledged', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const other = await journals.open({ identity: OTHER, stateDirectory: root })
    const connection = openTestJournalHostDatabase(root).db
    const published = vi.fn()
    journal.observeCommits(published)
    const cursor = journal.cursor()
    const rows = () =>
      readTestJournalRows(connection, IDENTITY.sessionId, journal.epoch).map((row) => row.seq)
    const rowsBefore = rows()
    const stopFailing = failCommits(connection)

    await expect(journal.appendSubmission(SUBMISSION)).rejects.toThrow(
      'FOREIGN KEY constraint failed'
    )
    expect(connection.isTransaction).toBe(false)
    stopFailing()

    expect(published).not.toHaveBeenCalled()
    expect(journal.cursor()).toEqual(cursor)
    expect(journal.submissions()).toEqual([])
    expect(rows()).toEqual(rowsBefore)
    await expect(
      other.appendItem(item(1), text('another chat'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).resolves.toBeDefined()
  })

  it('refuses every chat while a failed transaction will not roll back, then serves them', async () => {
    const other = await journals.open({ identity: OTHER, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const connection = database.db
    const exec = connection.exec.bind(connection)
    let rollbackFails = true
    vi.spyOn(connection, 'exec').mockImplementation((sql) => {
      if (sql === 'ROLLBACK' && rollbackFails) {
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })
      }
      exec(sql)
    })
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const stopFailing = failCommits(connection)

    // A first-use copy's batch, under the unsynced level. Its caller gets the COMMIT's own error.
    expect(() =>
      database.unsyncedTransaction((db) =>
        db
          .prepare(
            'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
          )
          .run('copying', 'epoch-copying', 1, 1, '{}')
      )
    ).toThrow('FOREIGN KEY constraint failed')
    expect(connection.isTransaction).toBe(true)
    await expect(
      other.appendItem(item(1), text('refused'), {
        fence: 1,
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      })
    ).rejects.toMatchObject({
      refusal: {
        code: 'agent_session_journal_unreadable',
        details: { reason: 'journalUnavailable' }
      }
    })

    rollbackFails = false
    expect(database.db.isTransaction).toBe(false)
    stopFailing()
    // Restored with the ROLLBACK: no later commit runs at the copy's unsynced level.
    expect(Number(connection.pragma('synchronous', { simple: true }))).toBe(2)
    await expect(
      other.appendItem(item(1), text('served'), { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE })
    ).resolves.toBeDefined()
    expect(readTestJournalRows(connection, OTHER.sessionId, other.epoch)).not.toHaveLength(0)
  })

  it('refuses a transaction body that awaits', () => {
    const database = openTestJournalHostDatabase(root)
    expect(() => database.transaction(async () => undefined)).toThrow('must not await')
    // Rolled back: the connection is free for the next transaction.
    expect(database.db.isTransaction).toBe(false)
  })
})

describe('quit', () => {
  // T-quit-drain: a sink write still in flight while the host flushes lands before the one
  // connection closes, because the connection closes last.
  it('closes the one connection only after the host has flushed what was in flight', async () => {
    const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
    const database = openTestJournalHostDatabase(root)
    const installed = {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls only `stopDelivery` and `flushAllStreamedEvents` on the host.
      host: {
        stopDelivery: () => {},
        flushAllStreamedEvents: async () => {
          // A child's last row, delivered while quit is draining its sink.
          await new Promise<void>((resolve) => setTimeout(resolve, 10))
          await journal.appendItem(item(1), text('written during quit'), {
            fence: 1,
            turnScope: AGENT_JOURNAL_THREAD_SCOPE
          })
        }
      } as never,
      adapter: { closeAll: async () => undefined },
      journalDatabase: database,
      waitForRecovery: async () => undefined
    }

    await tearDownRuntime(installed, 'quit')

    expect(database.isClosed).toBe(true)
    closeTestJournalHostDatabases()
    const reopened = openTestJournalHostDatabase(root)
    expect(
      readTestJournalRows(reopened.db, IDENTITY.sessionId, journal.epoch).map((row) => row.seq)
    ).toEqual([1, 2])
  })
})
