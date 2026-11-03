import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from '../../../../sqlite/sync-database'
import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import { SCHEMA_VERSION } from '../contract-constants'

/** Stamp the narrow archive schema at v38 to isolate v39; a lower version could hide a broken rebuild. */
function seedLegacyDatabase(path: string): void {
  const db = new Database(path)
  db.exec(`
    CREATE TABLE worker_terminal_archives (
      dispatch_id   TEXT PRIMARY KEY,
      resource_id   TEXT NOT NULL,
      kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail')),
      content       TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO worker_terminal_archives (dispatch_id, resource_id, kind, content, created_at)
      VALUES ('d_old', 'res_old', 'terminal_tail', '{"lines":["kept"]}', '2026-01-01 00:00:00');
  `)
  db.pragma('user_version = 38')
  db.close()
}

describe('structured pointer schema migration', () => {
  // Use and clean a real temp directory: TMPDIR is absent on Windows CI.
  const tempRoots: string[] = []

  afterEach(() => {
    while (tempRoots.length > 0) {
      rmSync(tempRoots.pop() as string, { recursive: true, force: true })
    }
  })

  it('admits the structured archive kind and keeps existing rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-structured-migration-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    seedLegacyDatabase(path)
    const db = new OrchestrationDb(path)
    try {
      expect(db.db.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION)
      const kept = db.db
        .prepare('SELECT content FROM worker_terminal_archives WHERE dispatch_id = ?')
        .get('d_old') as { content: string }
      expect(kept.content).toContain('kept')
      db.storeWorkerTerminalArchive({
        dispatchId: 'd_new',
        resourceId: 'res_new',
        kind: 'structured_journal',
        content: '{"version":1}'
      })
      expect(db.getWorkerTerminalArchive('d_new')?.kind).toBe('structured_journal')
    } finally {
      db.close()
    }
  })

  it('creates the structured mail send store', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      expect(db.getStructuredMailSends('dispatch:d1')).toEqual([])
      const row = {
        mailbox_handle: 'dispatch:d1',
        message_id: 'm1',
        session_id: 's1',
        operation_id: '1757030400000-0123456789abcdef0123456789abcdef',
        minted_at_ms: 1_757_030_400_000
      }
      expect(db.reserveStructuredMailSend(row)).toBe(true)
      expect(db.getStructuredMailSends('dispatch:d1').map((row) => row.operation_id)).toEqual([
        '1757030400000-0123456789abcdef0123456789abcdef'
      ])
      expect(db.releaseStructuredMailSend(row)).toBe(true)
      expect(db.getStructuredMailSends('dispatch:d1')).toEqual([])
    } finally {
      db.close()
    }
  })

  it('keeps sends an unreleased build saved with a fence, and takes new ones', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-structured-migration-'))
    tempRoots.push(root)
    const path = join(root, 'orchestration.db')
    const seeded = new Database(path)
    seeded.exec(`
      CREATE TABLE structured_mail_sends (
        mailbox_handle TEXT NOT NULL,
        message_id     TEXT NOT NULL,
        session_id     TEXT NOT NULL,
        operation_id   TEXT NOT NULL,
        minted_at_ms   INTEGER NOT NULL,
        fence          INTEGER NOT NULL,
        PRIMARY KEY (mailbox_handle, message_id)
      );
      INSERT INTO structured_mail_sends VALUES ('dispatch:d1', 'm1', 's1', 'op-saved', 1, 3);
    `)
    seeded.pragma(`user_version = ${SCHEMA_VERSION}`)
    seeded.close()
    const db = new OrchestrationDb(path)
    try {
      expect(
        db.reserveStructuredMailSend({
          mailbox_handle: 'dispatch:d1',
          message_id: 'm2',
          session_id: 's1',
          operation_id: 'op-new',
          minted_at_ms: 2
        })
      ).toBe(true)
      expect(db.getStructuredMailSends('dispatch:d1')).toEqual([
        {
          mailbox_handle: 'dispatch:d1',
          message_id: 'm1',
          session_id: 's1',
          operation_id: 'op-saved',
          minted_at_ms: 1
        },
        {
          mailbox_handle: 'dispatch:d1',
          message_id: 'm2',
          session_id: 's1',
          operation_id: 'op-new',
          minted_at_ms: 2
        }
      ])
    } finally {
      db.close()
    }
  })
})
