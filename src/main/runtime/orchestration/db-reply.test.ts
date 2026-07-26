import { afterEach, describe, expect, it } from 'vitest'
import type Database from '../../sqlite/sync-database'
import { OrchestrationDb } from './db'

describe('OrchestrationDb reply transactions', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
  })

  function createDb(): OrchestrationDb {
    db = new OrchestrationDb(':memory:')
    return db
  }

  it('atomically inserts a reply and marks the original as read', () => {
    const d = createDb()
    const original = d.insertMessage({ from: 'a', to: 'b', subject: 'question' })

    const reply = d.insertReplyAndMarkRead(original.id, {
      from: 'b',
      to: 'a',
      subject: 'Re: question',
      threadId: original.id
    })

    expect(d.getMessageById(original.id)?.read).toBe(1)
    expect(d.getMessageById(reply.id)?.thread_id).toBe(original.id)
  })

  it('keeps the original unread when reply insertion fails', () => {
    const d = createDb()
    const original = d.insertMessage({ from: 'a', to: 'b', subject: 'question' })
    const sqlite = (d as unknown as { db: Database.Database }).db
    sqlite.exec(`
      CREATE TRIGGER fail_reply_insert
      BEFORE INSERT ON messages
      WHEN NEW.subject = 'Re: question'
      BEGIN
        SELECT RAISE(ABORT, 'forced reply insert failure');
      END
    `)

    expect(() =>
      d.insertReplyAndMarkRead(original.id, {
        from: 'b',
        to: 'a',
        subject: 'Re: question',
        threadId: original.id
      })
    ).toThrow('forced reply insert failure')

    expect(d.getMessageById(original.id)?.read).toBe(0)
    expect(d.getAllMessagesForHandle('a')).toHaveLength(0)
  })
})
