import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb, type MessageType } from './db'

const runId = 'run_legacy_local'

describe('OrchestrationDb', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  describe('messages', () => {
    it('settles accepted notice members without changing prior timestamps or another mailbox', () => {
      const d = createDb()
      const pointed = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'pointed' })
      const fetched = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'fetched' })
      const foreign = d.insertMessage({ runId, from: 'a', to: 'c', subject: 'foreign' })
      const audit = d.insertMessage({
        runId,
        from: 'a',
        to: 'b',
        subject: 'audit',
        deliveryContract: 'audit_only'
      })
      d.db
        .prepare('UPDATE messages SET delivered_at = ? WHERE id = ?')
        .run('2026-01-01 00:00:00', pointed.id)
      d.markAsRead([fetched.id])

      d.markUnpointedMailboxMessagesAsDelivered('b', [pointed.id, fetched.id, foreign.id, audit.id])

      expect(d.getMessageById(pointed.id)?.delivered_at).toBe('2026-01-01T00:00:00Z')
      expect(d.getMessageById(fetched.id)).toMatchObject({
        read: 1,
        delivered_at: expect.any(String)
      })
      expect(d.getMessageById(foreign.id)?.delivered_at).toBeNull()
      expect(d.getMessageById(audit.id)?.delivered_at).toBeNull()
    })

    it('inserts and retrieves a message', () => {
      const d = createDb()
      const msg = d.insertMessage({
        runId,
        from: 'term_a',
        to: 'term_b',
        subject: 'hello',
        body: 'world'
      })
      expect(msg.id).toMatch(/^msg_/)
      expect(msg.from_handle).toBe('term_a')
      expect(msg.to_handle).toBe('term_b')
      expect(msg.subject).toBe('hello')
      expect(msg.body).toBe('world')
      expect(msg.type).toBe('status')
      expect(msg.priority).toBe('normal')
      expect(msg.read).toBe(0)
      expect(msg.sequence).toBeGreaterThan(0)
    })

    it('returns unread messages in sequence order', () => {
      const d = createDb()
      d.insertMessage({ runId, from: 'a', to: 'b', subject: 'first' })
      d.insertMessage({ runId, from: 'a', to: 'b', subject: 'second' })
      d.insertMessage({ runId, from: 'a', to: 'c', subject: 'other' })

      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(2)
      expect(unread[0].subject).toBe('first')
      expect(unread[1].subject).toBe('second')
    })

    it('filters unread by type', () => {
      const d = createDb()
      d.insertMessage({
        runId,
        from: 'a',
        to: 'b',
        subject: 'status msg',
        type: 'status'
      })
      d.insertMessage({
        runId,
        from: 'a',
        to: 'b',
        subject: 'done msg',
        type: 'worker_done'
      })

      const filtered = d.getUnreadMessages('b', ['worker_done'])
      expect(filtered).toHaveLength(1)
      expect(filtered[0].type).toBe('worker_done')
    })

    it('excludes already-delivered rows from getUndeliveredUnreadMessages', () => {
      const d = createDb()
      const m1 = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'one' })
      const m2 = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'two' })

      d.markAsDelivered([m1.id])

      // Push delivery query: only undelivered, unread.
      const pending = d.getUndeliveredUnreadMessages('b')
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe(m2.id)

      // Explicit `check` still sees both (they are still unread).
      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(2)
    })

    it('selects independent mail beyond the SQLite parameter limit of owned IDs', () => {
      const d = createDb()
      const owned = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'owned' })
      const fresh = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'fresh' })
      const excludeMessageIds = Array.from({ length: 250001 }, (_, index) => `owned-${index}`)
      excludeMessageIds.push(owned.id)

      const selected = d.getUndeliveredUnreadMessages('b', undefined, {
        excludeMessageIds,
        limit: 50
      })

      expect(selected.map((message) => message.id)).toEqual([fresh.id])
    })

    it('excludes all owned members before applying the notice limit', () => {
      const d = createDb()
      const owned = Array.from({ length: 51 }, (_, index) =>
        d.insertMessage({ runId, from: 'a', to: 'b', subject: `owned-${index}` })
      )
      const fresh = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'fresh' })

      const selected = d.getUndeliveredUnreadMessages('b', undefined, {
        excludeMessageIds: owned.map((message) => message.id),
        limit: 50
      })

      expect(selected.map((message) => message.id)).toEqual([fresh.id])
    })

    it('creates the undelivered inbox index used by push delivery', () => {
      const d = createDb()
      const sqlite = (d as unknown as { db: Database.Database }).db

      const indexes = sqlite
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND name = 'idx_messages_undelivered_inbox'`
        )
        .all()

      expect(indexes).toHaveLength(1)
    })

    it('filters getUndeliveredUnreadMessages by type', () => {
      const d = createDb()
      d.insertMessage({
        runId,
        from: 'a',
        to: 'b',
        subject: 's',
        type: 'status'
      })
      const wd = d.insertMessage({
        runId,
        from: 'a',
        to: 'b',
        subject: 'd',
        type: 'worker_done'
      })

      const filtered = d.getUndeliveredUnreadMessages('b', ['worker_done'])
      expect(filtered).toHaveLength(1)
      expect(filtered[0].id).toBe(wd.id)
    })

    it('marks messages as read', () => {
      const d = createDb()
      const m1 = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'one' })
      const m2 = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'two' })

      d.markAsRead([m1.id])

      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(1)
      expect(unread[0].id).toBe(m2.id)
    })

    it('rejects invalid message type', () => {
      const d = createDb()
      expect(() =>
        d.insertMessage({
          runId,
          from: 'a',
          to: 'b',
          subject: 'bad',
          type: 'invalid' as MessageType
        })
      ).toThrow()
    })

    it('getInbox returns all messages across recipients', () => {
      const d = createDb()
      d.insertMessage({ runId, from: 'a', to: 'b', subject: 'one' })
      d.insertMessage({ runId, from: 'a', to: 'c', subject: 'two' })
      d.insertMessage({ runId, from: 'b', to: 'a', subject: 'three' })

      const inbox = d.getInbox(10)
      expect(inbox).toHaveLength(3)
    })
  })
})
