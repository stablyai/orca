import { afterEach, describe, expect, it } from 'vitest'

import { OrchestrationDb } from './db'

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

    it('excludes already-delivered rows from getUndeliveredUnreadMessages', () => {
      const d = createDb()
      const m1 = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'one' })
      const m2 = d.insertMessage({ runId, from: 'a', to: 'b', subject: 'two' })

      d.markAsDelivered([m1.id], 'b')

      const pending = d.getUndeliveredUnreadMessages('b')
      expect(pending).toHaveLength(1)
      expect(pending[0].id).toBe(m2.id)

      const unread = d.getUnreadMessages('b')
      expect(unread).toHaveLength(2)
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
  })
})
