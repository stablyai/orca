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

  it('persists and settles a pending pointer Enter independently of delivery', () => {
    db = new OrchestrationDb(':memory:')
    const message = db.insertMessage({ from: 'a', to: 'run:run_1', subject: 'staged' })

    expect(
      db.stageMailboxPointerEnter([message.id], {
        ptyId: 'pty-1',
        processIncarnation: 'pty-1:inc-1'
      })
    ).toBe(true)
    const target = { ptyId: 'pty-1', processIncarnation: 'pty-1:inc-1' }
    expect(db.markMailboxPointerWriteAttempted([message.id], target)).toBe(true)
    expect(db.markMailboxPointerEnterAttempted([message.id], target)).toBe(true)

    expect(db.getUndeliveredUnreadMailboxHandles()).toEqual([])
    expect(db.getPendingMailboxPointerHandles()).toEqual(['run:run_1'])
    expect(db.getPendingMailboxPointerMessages('run:run_1')).toEqual([
      expect.objectContaining({
        id: message.id,
        delivered_at: null,
        pointer_enter_pending: 3,
        pointer_pty_id: 'pty-1',
        pointer_process_incarnation: 'pty-1:inc-1'
      })
    ])

    db.settleMailboxPointerEnter([message.id], target, [3])
    expect(db.getPendingMailboxPointerHandles()).toEqual([])
    expect(db.getMessageById(message.id)).toMatchObject({
      delivered_at: expect.any(String),
      pointer_enter_pending: 0
    })
  })
})
