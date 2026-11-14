import { describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../orchestration-db'
import '../contract-constants'
import './mailbox-routing-page'
import '../dispatch-row-writer'
import '../attempt-outcome-projection'

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
      db.releasePendingMailboxPointerForPty('target')
      const read = (id: string) => db.db.prepare('SELECT * FROM messages WHERE id = ?').get(id)
      for (const id of ['reserved', 'read']) {
        expect(read(id)).toMatchObject({
          pointer_enter_pending: 0,
          pointer_pty_id: null,
          pointer_process_incarnation: null
        })
      }
      expect(read('reserved')).toMatchObject({ delivered_at: null, read: 0 })
      for (const [id, phase] of [
        ['written', 2],
        ['entered', 3]
      ] as const) {
        expect(read(id)).toMatchObject({
          read: 0,
          delivered_at: null,
          pointer_enter_pending: phase,
          pointer_pty_id: 'target',
          pointer_process_incarnation: 'incarnation'
        })
      }
      expect(read('read')).toMatchObject({ delivered_at: '2026-01-01 00:00:00', read: 1 })
      expect(read('other')).toMatchObject({ pointer_enter_pending: 1, pointer_pty_id: 'other-pty' })
      expect(read('history-0')).toMatchObject({ read: 1, delivered_at: null })
    } finally {
      db.close()
    }
  })
})
