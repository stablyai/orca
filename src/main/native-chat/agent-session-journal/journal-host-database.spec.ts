import { failNextNativeJournalStatement } from './journal-native-test-instrumentation'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { spawnProcess } from '@orca/process-host'
import { tearDownRuntime } from '../../runtime/agent-session/structured-agent-session-runtime-teardown'
import { journalDatabasePath } from './journal-host-database'
import {
  closeTestJournalHostDatabases,
  createTrackedJournalOpener,
  openTestJournalHostDatabase,
  readTestJournalRows
} from './journal-host-database-test-support'
import type Database from '../../sqlite/sync-database'
import { codexProviderHandle } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'

export function registerJournalHostDatabaseTests(): void {
  const IDENTITY: AgentSessionJournalIdentity = {
    sessionId: 'session-1',
    workspaceId: 'ws-1',
    hostId: 'local',
    agent: 'codex',
    providerHandle: codexProviderHandle('thread-1')
  }

  const OTHER: AgentSessionJournalIdentity = {
    ...IDENTITY,
    sessionId: 'session-2',
    providerHandle: codexProviderHandle('thread-2')
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
  const journals = createTrackedJournalOpener({ legacyInputs: true })

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  /** Deferred foreign-key failures leave COMMIT open, exercising shared-connection rollback recovery. */
  function failCommits(db: Database.Database): () => void {
    db.exec(`CREATE TABLE commit_probe_parent (id INTEGER PRIMARY KEY);
  CREATE TABLE commit_probe_child (
    parent INTEGER REFERENCES commit_probe_parent (id) DEFERRABLE INITIALLY DEFERRED
  );
  CREATE TRIGGER commit_probe AFTER INSERT ON main.journal_rows
  BEGIN INSERT INTO commit_probe_child (parent) VALUES (1); END`)
    return () => db.exec('DROP TRIGGER commit_probe')
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

    it('fails only the write whose transaction could not begin', async () => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const database = await openTestJournalHostDatabase(root)
      await failNextNativeJournalStatement(database, 'BEGIN IMMEDIATE', 'database is locked')
      await expect(
        journal.appendItem(item(1), text('refused'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).rejects.toThrow('database is locked')
      await expect(
        journal.appendItem(item(2), text('next'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).resolves.toBeDefined()
      expect(journal.snapshot().items.map((entry) => entry.body)).toEqual([text('next')])
    })

    it('frees the connection after a failed COMMIT: nothing adopted, published or acknowledged', async () => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const other = await journals.open({ identity: OTHER, stateDirectory: root })
      const connection = (await openTestJournalHostDatabase(root)).db
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

    it('faults every chat after an unconfirmed rollback and joins the old owner before reopening', async () => {
      const other = await journals.open({ identity: OTHER, stateDirectory: root })
      const database = await openTestJournalHostDatabase(root)
      failCommits(database.db)
      await failNextNativeJournalStatement(database, 'ROLLBACK', 'disk I/O error')
      await expect(
        database.transaction((plan) =>
          plan.add({
            kind: 'rows',
            sessionId: 'unknown',
            rows: [
              {
                epoch: 'epoch-unknown',
                seq: 1,
                savedAt: 1,
                json: '{}'
              }
            ]
          })
        )
      ).rejects.toThrow()
      expect(database.isFaulted).toBe(true)
      await expect(
        other.appendItem(item(1), text('refused'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).rejects.toThrow()
      await database.close()
      expect(database.hasClosed).toBe(true)
      const reopened = await openTestJournalHostDatabase(root)
      reopened.db.exec('DROP TRIGGER commit_probe')
      const replacement = await journals.open({ identity: OTHER, stateDirectory: root })
      await expect(
        replacement.appendItem(item(1), text('served'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).resolves.toBeDefined()
      expect(readTestJournalRows(reopened.db, OTHER.sessionId, replacement.epoch)).not.toHaveLength(
        0
      )
    })

    it('prepares across awaits before acquiring the native transaction', async () => {
      const database = await openTestJournalHostDatabase(root)
      await expect(
        database.transaction(async () => {
          database.db.exec('BEGIN IMMEDIATE')
          database.db.exec('ROLLBACK')
          await Promise.resolve()
          expect(database.db.isTransaction).toBe(false)
          return 'prepared'
        })
      ).resolves.toBe('prepared')
      expect(database.db.isTransaction).toBe(false)
    })
  })

  describe('quit', () => {
    it('closes the one connection only after the host has flushed what was in flight', async () => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const database = await openTestJournalHostDatabase(root)
      const installed = {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: teardown calls the supplied producer stop, flush and status-drain stages.
        host: {
          stopDelivery: () => {},
          drainStatusWrites: async () => {
            expect(database.isClosed).toBe(false)
            expect(
              readTestJournalRows(database.db, IDENTITY.sessionId, journal.epoch).map(
                (row) => row.seq
              )
            ).toEqual([1, 2])
          },
          flushAllStreamedEvents: async () => {
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
      await closeTestJournalHostDatabases()
      const reopened = await openTestJournalHostDatabase(root)
      expect(
        readTestJournalRows(reopened.db, IDENTITY.sessionId, journal.epoch).map((row) => row.seq)
      ).toEqual([1, 2])
    })
  })
}
