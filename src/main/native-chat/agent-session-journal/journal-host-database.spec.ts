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
  readTestJournalRows,
  loadTestJournal
} from './journal-host-database-test-support'
import {
  failNextNativeJournalStatement,
  failNativeJournalStatements
} from './journal-native-test-instrumentation'
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
      const database = await openTestJournalHostDatabase(root)
      const published = vi.fn()
      journal.observeCommits(published)
      const cursor = journal.cursor()
      const rows = async () =>
        (await readTestJournalRows(database, IDENTITY.sessionId, journal.epoch)).map(
          (row) => row.seq
        )
      const rowsBefore = await rows()
      await failNextNativeJournalStatement(database, 'COMMIT', 'commit refused')

      await expect(journal.appendSubmission(SUBMISSION)).rejects.toThrow('commit refused')

      expect(published).not.toHaveBeenCalled()
      expect(journal.cursor()).toEqual(cursor)
      expect(journal.submissions()).toEqual([])
      expect(await rows()).toEqual(rowsBefore)
      await expect(
        other.appendItem(item(1), text('another chat'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).resolves.toBeDefined()
    })

    it('fences every chat after an indeterminate write until its owners close and recover', async () => {
      const journal = await journals.open({ identity: IDENTITY, stateDirectory: root })
      const other = await journals.open({ identity: OTHER, stateDirectory: root })
      const database = await openTestJournalHostDatabase(root)
      await failNativeJournalStatements(database, [
        { sql: 'COMMIT', message: 'commit refused' },
        { sql: 'ROLLBACK', message: 'disk I/O error' }
      ])
      await expect(journal.appendSubmission(SUBMISSION)).rejects.toMatchObject({
        name: 'JournalIndeterminateWriteError',
        cause: expect.objectContaining({ message: 'commit refused' })
      })
      expect(database.isFaulted).toBe(true)
      await expect(
        other.appendItem(item(1), text('refused'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).rejects.toBeDefined()
      await journals.closeAll()
      const recovered = await journals.open({ identity: OTHER, stateDirectory: root })
      await expect(
        recovered.appendItem(item(1), text('served after recovery'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).resolves.toBeDefined()
      expect(recovered.snapshot().items.map((entry) => entry.body)).toEqual([
        text('served after recovery')
      ])
      expect((await loadTestJournal(root, IDENTITY.sessionId))?.state.submissions.size).toBe(0)
    })

    it('serializes awaited preparation before the following transaction', async () => {
      const database = await openTestJournalHostDatabase(root)
      const order: string[] = []
      let release: () => void = () => {}
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const first = database.transaction(
        async () => {
          order.push('preparing')
          await waiting
          order.push('prepared')
        },
        false,
        () => {
          order.push('adopted')
        }
      )
      const next = database.transaction(() => {
        order.push('next')
      })
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(order).not.toContain('next')
      release()
      await Promise.all([first, next])
      expect(order).toEqual(['preparing', 'prepared', 'adopted', 'next'])
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
              (await readTestJournalRows(database, IDENTITY.sessionId, journal.epoch)).map(
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
        (await readTestJournalRows(reopened, IDENTITY.sessionId, journal.epoch)).map(
          (row) => row.seq
        )
      ).toEqual([1, 2])
    })
  })
}
