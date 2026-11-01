import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

function assertTargetedRelease(db: OrchestrationDb): void {
  const prepare = vi.spyOn(db.db, 'prepare')
  db.releasePendingMailboxPointerForPty('absent-pty')
  const sql = prepare.mock.calls.find(([query]) => query.startsWith('UPDATE messages'))?.[0]
  prepare.mockRestore()
  expect(sql).toBeDefined()
  const plan = db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 'absent-pty') as {
    detail: string
  }[]
  expect(plan.some(({ detail }) => detail.includes('SCAN messages'))).toBe(false)
  expect(plan.some(({ detail }) => detail.includes('idx_messages_pending_pointer_pty'))).toBe(true)
}

describe('PTY mailbox reservation cleanup', () => {
  it('uses a PTY lookup and preserves reservation settlement semantics', () => {
    const db = new OrchestrationDb(':memory:')
    try {
      const seed = db.db.prepare(`INSERT INTO messages
        (id, from_handle, to_handle, subject, read, pointer_enter_pending,
         pointer_pty_id, pointer_process_incarnation, delivered_at)
        VALUES (?, 'sender', 'recipient', 'test', ?, ?, ?, 'incarnation', ?)`)
      db.db.exec('BEGIN')
      for (let i = 0; i < 1000; i++) {
        seed.run(`history-${i}`, 1, 0, null, null)
      }
      seed.run('reserved', 0, 1, 'target', '2026-01-01 00:00:00')
      seed.run('written', 0, 2, 'target', null)
      seed.run('entered', 0, 3, 'target', null)
      seed.run('read', 1, 2, 'target', '2026-01-01 00:00:00')
      seed.run('other', 0, 1, 'other-pty', null)
      db.db.exec('COMMIT')
      assertTargetedRelease(db)
      db.releasePendingMailboxPointerForPty('target')
      const read = (id: string) => db.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
      for (const id of ['reserved', 'written', 'entered', 'read']) {
        expect(read(id)).toMatchObject({
          pointer_enter_pending: 0,
          pointer_pty_id: null,
          pointer_process_incarnation: null
        })
      }
      expect(read('reserved')).toMatchObject({ delivered_at: null, read: 0 })
      expect(read('written')).toMatchObject({ delivered_at: expect.any(String), read: 0 })
      expect(read('entered')).toMatchObject({ delivered_at: expect.any(String), read: 0 })
      expect(read('read')).toMatchObject({ delivered_at: '2026-01-01 00:00:00', read: 1 })
      expect(read('other')).toMatchObject({ pointer_enter_pending: 1, pointer_pty_id: 'other-pty' })
      expect(read('history-0')).toMatchObject({ read: 1, delivered_at: null })
    } finally {
      db.close()
    }
  })

  it.each(['current', 'before-pointer-columns'])(
    'installs the lookup on first open of an existing %s database',
    (version) => {
      const dir = mkdtempSync(join(tmpdir(), 'orca-pointer-release-'))
      const path = join(dir, 'orchestration.db')
      try {
        new OrchestrationDb(path).close()
        const raw = new Database(path)
        try {
          raw.exec('DROP INDEX idx_messages_pending_pointer_pty')
          if (version === 'before-pointer-columns') {
            raw.exec(`DROP INDEX idx_messages_pending_pointer_enter;
              ALTER TABLE messages DROP COLUMN pointer_enter_pending;
              ALTER TABLE messages DROP COLUMN pointer_pty_id;
              ALTER TABLE messages DROP COLUMN pointer_process_incarnation;`)
            raw.pragma('user_version = 32')
          }
        } finally {
          raw.close()
        }
        const reopened = new OrchestrationDb(path)
        try {
          assertTargetedRelease(reopened)
        } finally {
          reopened.close()
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
})
