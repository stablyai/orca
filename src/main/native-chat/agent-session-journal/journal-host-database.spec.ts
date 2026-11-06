import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemIdentity,
  AgentSessionJournalIdentity
} from '../../../shared/agent-session/journal/agent-session-journal-identity'
import {
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

  let root: string
  const journals = createTrackedJournalOpener({ legacyInputs: true })

  function item(ordinal: number): AgentJournalItemIdentity {
    return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
  }

  /** Deferred foreign-key failures leave COMMIT open, exercising shared-connection rollback recovery. */
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
    it('refuses every chat while a failed transaction will not roll back, then serves them', async () => {
      const other = await journals.open({ identity: OTHER, stateDirectory: root })
      const database = openTestJournalHostDatabase(root)
      const connection = database.db
      const exec = connection.exec.bind(connection)
      let rollbackFails = true
      vi.spyOn(connection, 'exec').mockImplementation((sql) => {
        if (sql === 'ROLLBACK' && rollbackFails) {
          throw Object.assign(new Error('disk I/O error'), {
            code: 'ERR_SQLITE_ERROR',
            errcode: 10
          })
        }
        exec(sql)
      })
      vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      const stopFailing = failCommits(connection)

      expect(() =>
        database.transaction((db) =>
          db
            .prepare(
              'INSERT INTO journal_rows (session_id, epoch, seq, ts, row_json) VALUES (?, ?, ?, ?, ?)'
            )
            .run('unknown', 'epoch-unknown', 1, 1, '{}')
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
      await expect(
        other.appendItem(item(1), text('served'), {
          fence: 1,
          turnScope: AGENT_JOURNAL_THREAD_SCOPE
        })
      ).resolves.toBeDefined()
      expect(readTestJournalRows(connection, OTHER.sessionId, other.epoch)).not.toHaveLength(0)
    })

    it('refuses a transaction body that awaits', () => {
      const database = openTestJournalHostDatabase(root)
      expect(() => database.transaction(async () => undefined)).toThrow('must not await')
      expect(database.db.isTransaction).toBe(false)
    })
  })
}
