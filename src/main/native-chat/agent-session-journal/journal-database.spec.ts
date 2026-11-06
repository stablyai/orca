import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { openJournalDatabase } from './journal-database'
import { JOURNAL_DB_SCHEMA_VERSION } from './journal-database-schema'
import { journalDatabasePath } from './journal-host-database'
import {
  insertJournalRow,
  iterateJournalEpochRows,
  publishJournalSessionEpoch,
  readJournalSessionEpoch
} from './journal-row-table'
import type { JournalRow } from './journal-row-schema'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../../shared/agent-session/journal/agent-session-journal-types'

export function registerJournalDatabaseTests(): void {
  let root: string
  let dbPath: string

  function epochRow(seq: number, epoch = 'epoch-1'): JournalRow {
    return {
      kind: 'epoch',
      reason: 'session_created',
      providerHandle: { kind: 'codex', threadId: 'thread-1' },
      v: AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
      epoch,
      seq,
      fence: 0,
      ts: 1_700_000_000_000 + seq
    }
  }

  const SESSION = { sessionId: 'session-1', workspaceId: 'ws-1' }

  async function digest(path: string): Promise<string> {
    return createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-journal-db-'))
    dbPath = journalDatabasePath(root)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  describe('the host journal database open', () => {
    it('opens a newer user_version read-only without touching the file', async () => {
      const seeded = openJournalDatabase(dbPath).db
      publishJournalSessionEpoch(seeded, SESSION, 'epoch-1')
      insertJournalRow(seeded, 'session-1', epochRow(1))
      seeded.pragma(`user_version = ${JOURNAL_DB_SCHEMA_VERSION + 5}`)
      seeded.close()
      const before = await digest(dbPath)

      const opened = openJournalDatabase(dbPath)
      try {
        expect(opened.readOnly).toBe(true)
        expect(readJournalSessionEpoch(opened.db, 'session-1')).toBe('epoch-1')
        expect([...iterateJournalEpochRows(opened.db, 'session-1', 'epoch-1')]).toHaveLength(1)
        expect(() => insertJournalRow(opened.db, 'session-1', epochRow(2))).toThrow(/readonly/i)
      } finally {
        opened.db.close()
      }

      expect(await digest(dbPath)).toBe(before)
      // Read-only WAL access may create empty logs, but must never append frames.
      expect((await stat(`${dbPath}-wal`).catch(() => null))?.size ?? 0).toBe(0)
    })
  })

  describe('schema creation', () => {
    it('publishes no table until the version bump commits with it', () => {
      const original = Database.prototype.pragma
      const pragma = vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (
        this: Database.Database,
        sql: string,
        options?: { simple?: boolean }
      ) {
        if (sql.startsWith('user_version =')) {
          throw new Error('crash before the version is published')
        }
        return original.call(this, sql, options)
      })

      expect(() => openJournalDatabase(dbPath)).toThrow('crash before the version is published')
      pragma.mockRestore()

      const inspected = new Database(dbPath)
      try {
        expect(inspected.pragma('user_version', { simple: true })).toBe(0)
        expect(
          inspected
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'journal_rows'"
            )
            .get()
        ).toBeUndefined()
      } finally {
        inspected.close()
      }
    })
  })
}
