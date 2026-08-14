import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('undelivered orchestration mailboxes', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => db?.close())

  it('lists only mailboxes with undelivered unread messages', () => {
    db = new OrchestrationDb(':memory:')
    const delivered = db.insertMessage({ from: 'a', to: 'delivered', subject: 'done' })
    const read = db.insertMessage({ from: 'a', to: 'read', subject: 'seen' })
    db.insertMessage({ from: 'a', to: 'pending', subject: 'first' })
    db.insertMessage({ from: 'a', to: 'pending', subject: 'second' })
    db.markAsDelivered([delivered.id])
    db.markAsRead([read.id])

    expect(db.getUndeliveredUnreadMailboxHandles()).toEqual(['pending'])
  })
})
