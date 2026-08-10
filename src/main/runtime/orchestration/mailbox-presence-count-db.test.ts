import { afterEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from './db'

describe('mailbox presence count', () => {
  let db: OrchestrationDb | undefined

  afterEach(() => {
    db?.close()
    db = undefined
  })

  function setup(): { db: OrchestrationDb; runId: string; address: string } {
    const created = new OrchestrationDb(':memory:')
    db = created
    const runId = created.createRun({
      objective: 'presence',
      coordinatorHandle: 'term_coord',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    }).id
    return { db: created, runId, address: `run:${runId}` }
  }

  it('reports zero for an empty mailbox', () => {
    const { db: target, runId, address } = setup()

    expect(target.countUnreadMessages({ toHandle: address, runId })).toEqual({
      total: 0,
      byDeliveryClass: { interrupt: 0, tool: 0, turn: 0 }
    })
  })

  it('breaks the unread count down by delivery class', () => {
    const { db: target, runId, address } = setup()
    for (const deliveryClass of ['interrupt', 'tool', 'turn', 'turn'] as const) {
      target.insertMessage({
        from: 'term_a',
        to: address,
        subject: deliveryClass,
        deliveryClass,
        runId
      })
    }

    expect(target.countUnreadMessages({ toHandle: address, runId })).toEqual({
      total: 4,
      byDeliveryClass: { interrupt: 1, tool: 1, turn: 2 }
    })
  })

  it('ignores read mail, other mailboxes, and audit-only rows', () => {
    const { db: target, runId, address } = setup()
    const read = target.insertMessage({
      from: 'term_a',
      to: address,
      subject: 'already seen',
      deliveryClass: 'interrupt',
      runId
    })
    target.markAsRead([read.id])
    target.insertMessage({ from: 'term_a', to: 'term_other', subject: 'not mine', runId })
    target.insertMessage({
      from: 'term_a',
      to: address,
      subject: 'audit',
      runId,
      deliveryContract: 'audit_only'
    })
    target.insertMessage({ from: 'term_a', to: address, subject: 'waiting', runId })

    expect(target.countUnreadMessages({ toHandle: address, runId }).total).toBe(1)
  })

  it('honors the same type filter a real check would use', () => {
    const { db: target, runId, address } = setup()
    target.insertMessage({
      from: 'term_a',
      to: address,
      subject: 'done',
      type: 'escalation',
      deliveryClass: 'interrupt',
      runId
    })
    target.insertMessage({ from: 'term_a', to: address, subject: 'fyi', type: 'status', runId })

    expect(target.countUnreadMessages({ toHandle: address, runId, types: ['escalation'] })).toEqual(
      {
        total: 1,
        byDeliveryClass: { interrupt: 1, tool: 0, turn: 0 }
      }
    )
  })

  it('counts mail a pre-upgrade row left without a class as turn', () => {
    const { db: target, runId, address } = setup()
    const message = target.insertMessage({ from: 'term_a', to: address, subject: 'legacy', runId })
    // Why: mirrors a row written before the column existed, which SQLite backfills to 'turn'.
    expect(target.getMessageById(message.id)?.delivery_class).toBe('turn')

    expect(target.countUnreadMessages({ toHandle: address, runId }).byDeliveryClass.turn).toBe(1)
  })

  it('leaves the mailbox untouched: nothing is marked read and no Delivery is created', () => {
    const { db: target, runId, address } = setup()
    const message = target.insertMessage({ from: 'term_a', to: address, subject: 'waiting', runId })

    target.countUnreadMessages({ toHandle: address, runId })

    expect(target.getMessageById(message.id)?.read).toBe(0)
    expect(target.getRunMailboxHistory(runId)).toHaveLength(1)
  })
})
