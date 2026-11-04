import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from './db'
import { OrchestrationStructuredMailboxPointerDelivery } from './structured-mailbox-pointer-delivery'
import type {
  StructuredMailboxPointerHost,
  StructuredPointerSendOutcome
} from './structured-mailbox-pointer-host-contract'

const databases: OrchestrationDb[] = []
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-03T12:00:00Z'))
})
afterEach(() => {
  for (const db of databases.splice(0)) {
    db.close()
  }
  vi.useRealTimers()
})
const drain = async () => {
  for (let n = 0; n < 5; n++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function fixture() {
  const db = new OrchestrationDb(':memory:')
  databases.push(db)
  const run = db.createRun({
    objective: 'held discovery',
    coordinatorHandle: 'term_coord',
    coordinatorPaneKey: 'tab:11111111-1111-4111-8111-111111111111'
  })
  const mailbox = `run:${run.id}`
  const attachment = {}
  let fence = 1
  let owner = 'session-1'
  let epoch = 1
  let stopAt: number | null = Date.parse('2026-11-03T12:00:00Z')
  let open = true
  let watch: (() => void) | undefined
  const eligibility = () => ({ host: attachment, fence, key: `${epoch}:${stopAt}`, stopAt })
  const host: StructuredMailboxPointerHost = {
    attachment: () => attachment,
    currentFence: () => fence,
    readEligibility: () => (open ? eligibility() : null),
    openEligibility: vi.fn(async () => {
      open = true
      return eligibility()
    }),
    watchJournal: (_session, callback) => {
      watch = callback
      return () => {
        watch = undefined
      }
    },
    observe: vi.fn(async () => ({ kind: 'absent' as const })),
    withdraw: async () => true,
    wakeQueue: () => {},
    send: vi.fn(async (): Promise<StructuredPointerSendOutcome> => ({
      kind: 'sent',
      state: 'accepted'
    }))
  }
  const delivery = new OrchestrationStructuredMailboxPointerDelivery({
    getDb: () => db,
    getMessageWaiters: () => undefined,
    resolveStructuredTarget: () => ({ sessionId: owner, dispatchId: null }),
    mailboxEnded: () => false,
    getCliCommand: () => 'orca-dev',
    senderSnapshot: () => ({ name: null, agent: null }),
    host
  })
  const arrive = (createdAt = '2026-11-03 11:59:59') => {
    const row = db.insertMessage({
      runId: run.id,
      from: 'term_worker',
      to: mailbox,
      subject: 'report'
    })
    db.db.prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(createdAt, row.id)
    return row.id
  }
  return {
    db,
    runId: run.id,
    host,
    delivery,
    mailbox,
    arrive,
    async deliver(cause: 'discovery' | 'service' = 'discovery') {
      delivery.deliverForHandle(mailbox, undefined, cause)
      await drain()
    },
    async edge() {
      watch?.()
      await drain()
    },
    resume() {
      stopAt = null
    },
    stop(at: number) {
      stopAt = at
    },
    close() {
      open = false
    },
    changeOwner() {
      owner = 'session-2'
      fence++
      epoch++
    }
  }
}

describe('Stop-held mailbox discovery', () => {
  it.each([10, 100])(
    'does no row discovery or reservations over ten unrelated edges with %i held reports',
    async (count) => {
      const h = fixture()
      for (let n = 0; n < count; n++) {
        h.arrive()
      }
      const select = vi.spyOn(h.db, 'getUndeliveredUnreadMessages')
      const format = vi.spyOn(h.db, 'getMessageById')
      const reserve = vi.spyOn(h.db, 'reserveStructuredMailSend')
      const release = vi.spyOn(h.db, 'releaseStructuredMailSend')
      h.delivery.deliverForHandle(h.mailbox, new Set(['other-type']))
      await drain()
      expect(h.host.send).not.toHaveBeenCalled()
      expect(reserve).not.toHaveBeenCalled()
      select.mockClear()
      format.mockClear()
      for (let n = 0; n < 10; n++) {
        await h.edge()
        await h.deliver('service')
      }
      expect(select).not.toHaveBeenCalled()
      expect(format).not.toHaveBeenCalled()
      expect(reserve).not.toHaveBeenCalled()
      expect(release).not.toHaveBeenCalled()
      // One real discovery may walk the held prefix; it must reach new mail beyond it.
      const fresh = h.arrive('2026-11-03 12:00:01')
      await h.deliver()
      expect(h.host.send).toHaveBeenCalledTimes(1)
      expect(h.db.getMessageById(fresh)?.read).toBe(1)
      expect(h.db.getUndeliveredUnreadMessages(h.mailbox)).toHaveLength(count)
      h.resume()
      await h.edge()
      expect(h.host.send).toHaveBeenCalledTimes(count + 1)
      expect(h.db.getUndeliveredUnreadMessages(h.mailbox)).toHaveLength(0)
    }
  )

  it.each([10, 100])(
    'uses the unread index with a one-row existence limit over %i direct reports',
    (count) => {
      const h = fixture()
      for (let n = 0; n < count; n++) {
        const id = h.arrive()
        h.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run('direct-reader', id)
      }
      const sql = `SELECT 1 FROM messages INDEXED BY idx_messages_unread_current_inbox
      WHERE to_handle = ? AND read = 0 AND delivery_contract = 'current_delivery' LIMIT 1`
      expect(h.db.hasUnreadDirectMessages('direct-reader')).toBe(true)
      expect(h.db.hasUnreadDirectMessages('empty-reader')).toBe(false)
      const plan = h.db.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('direct-reader')
      expect(plan.map((row) => row.detail).join(' ')).toContain(
        'SEARCH messages USING COVERING INDEX idx_messages_unread_current_inbox'
      )
      // SQLite decrements the LIMIT and exits before advancing to another matching index entry.
      const operations = h.db.db.prepare(`EXPLAIN ${sql}`).all('direct-reader')
      const output = operations.findIndex((row) => row.opcode === 'ResultRow')
      const next = operations.findIndex((row) => row.opcode === 'Next')
      expect(operations.slice(output + 1, next).some((row) => row.opcode === 'DecrJumpZero')).toBe(
        true
      )
    }
  )

  it('retains a refused point candidate across output edges without rescanning the held prefix', async () => {
    const h = fixture()
    for (let n = 0; n < 100; n++) {
      h.arrive()
    }
    const fresh = h.arrive('2026-11-03 12:00:01')
    vi.mocked(h.host.send).mockResolvedValueOnce({ kind: 'refused' })
    const select = vi.spyOn(h.db, 'getUndeliveredUnreadMessages')
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    select.mockClear()
    h.close()
    await h.edge()
    expect(h.host.openEligibility).toHaveBeenCalledTimes(1)
    expect(h.host.send).toHaveBeenCalledTimes(2)
    expect(h.db.getMessageById(fresh)?.read).toBe(1)
    expect(select).toHaveBeenCalledTimes(1) // finish the retained page, then find its end
  })

  it('keeps tie/invalid times held and retains the exact reservation of a never-admitted resend', async () => {
    const h = fixture()
    h.arrive('2026-11-03 12:00:00')
    h.arrive('unreadable')
    const id = h.arrive()
    const attempt = {
      mailbox_handle: h.mailbox,
      message_id: id,
      session_id: 'session-1',
      operation_id: `${Date.now()}-0123456789abcdef0123456789abcdef`,
      minted_at_ms: Date.now()
    }
    h.db.reserveStructuredMailSend(attempt)
    const reserve = vi.spyOn(h.db, 'reserveStructuredMailSend')
    const release = vi.spyOn(h.db, 'releaseStructuredMailSend')
    await h.deliver()
    await h.edge()
    expect(h.db.getStructuredMailSend(h.mailbox, id)).toEqual(attempt)
    expect(reserve).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    h.resume()
    await h.edge()
    expect(
      vi
        .mocked(h.host.send)
        .mock.calls.some(([input]) => input.operationId === attempt.operation_id)
    ).toBe(true)
  })

  it('reads a second Stop before reserving the next report and resumes without duplicates', async () => {
    const h = fixture()
    for (let n = 0; n < 3; n++) {
      h.arrive('2026-11-03 12:00:01')
    }
    vi.mocked(h.host.send).mockImplementationOnce(async () => {
      h.stop(Date.parse('2026-11-03T12:00:02Z'))
      return { kind: 'sent', state: 'accepted' }
    })
    await h.deliver()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    h.resume()
    await h.edge()
    expect(h.host.send).toHaveBeenCalledTimes(3)
  })

  it('redrives a released reservation at the row’s committed current address', async () => {
    const h = fixture()
    const destination = `run:${h.db.createRun({ objective: 'new owner', coordinatorHandle: 'term_coord', coordinatorPaneKey: null }).id}`
    const old = h.arrive()
    h.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(destination, old)
    const moved = h.arrive('2026-11-03 12:00:01')
    const attempt = {
      mailbox_handle: h.mailbox,
      message_id: moved,
      session_id: 'session-1',
      operation_id: `${Date.now()}-0123456789abcdef0123456789abcdef`,
      minted_at_ms: Date.now()
    }
    h.db.reserveStructuredMailSend(attempt)
    h.changeOwner()
    h.delivery.deliverForHandle(destination)
    await drain()
    expect(h.host.send).not.toHaveBeenCalled()
    // Moving alone preserves the old reservation; only its later release makes the row selectable.
    h.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(destination, moved)
    vi.mocked(h.host.observe).mockResolvedValue({ kind: 'waiting' })
    await h.deliver('service')
    await drain()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.db.getMessageById(moved)?.read).toBe(1)
    expect(h.db.getMessageById(old)?.read).toBe(0)
  })

  it('publishes no current-address release from a rolled-back outer transaction', async () => {
    const h = fixture()
    const destination = `run:${h.db.createRun({ objective: 'other mailbox', coordinatorHandle: 'term_coord', coordinatorPaneKey: null }).id}`
    const held = h.arrive()
    h.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(destination, held)
    h.delivery.deliverForHandle(destination)
    await drain()
    const moved = h.arrive('2026-11-03 12:00:01')
    const attempt = {
      mailbox_handle: h.mailbox,
      message_id: moved,
      session_id: 'session-1',
      operation_id: `${Date.now()}-0123456789abcdef0123456789abcdef`,
      minted_at_ms: Date.now()
    }
    h.db.reserveStructuredMailSend(attempt)
    const source = {
      kind: 'agent' as const,
      senders: [],
      orchestration: {
        message: 'mail-notice' as const,
        mailbox: h.mailbox,
        dispatchId: null,
        messages: [{ messageId: moved, runId: h.runId, from: 'term_worker' }]
      }
    }
    vi.mocked(h.host.observe).mockResolvedValue({ kind: 'waiting' })
    h.db.db.exec('BEGIN')
    h.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(destination, moved)
    expect(h.delivery.owedAtHandover('session-1', source, h.db)).toBe('stale')
    await drain() // savepoint released, outer transaction still uncommitted
    expect(h.host.send).not.toHaveBeenCalled()
    h.db.db.exec('ROLLBACK')
    await h.deliver('service')
    expect(h.db.getStructuredMailSend(h.mailbox, moved)).toEqual(attempt)
    expect(h.host.send).not.toHaveBeenCalled()
    h.db.db.exec('BEGIN')
    h.db.db.prepare('UPDATE messages SET to_handle = ? WHERE id = ?').run(destination, moved)
    h.delivery.owedAtHandover('session-1', source, h.db)
    h.db.db.exec('COMMIT')
    await drain()
    expect(h.host.send).toHaveBeenCalledTimes(1)
    expect(h.db.getMessageById(moved)?.read).toBe(1)
  })

  it('installs the watch before open and discards a reset’s delayed opener', async () => {
    const h = fixture()
    h.arrive()
    h.close()
    let finish: (() => void) | undefined
    vi.mocked(h.host.openEligibility).mockImplementationOnce(async () => {
      h.resume()
      await h.edge() // the watch is already installed, so this requests a rerun
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return null
    })
    h.delivery.deliverForHandle(h.mailbox)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    h.delivery.reset()
    finish?.()
    await drain()
    expect(h.host.send).not.toHaveBeenCalled()
  })

  it('does not reopen a swept chat on an unchanged held-only edge; a changed owner rebuilds', async () => {
    const h = fixture()
    h.arrive()
    await h.deliver()
    h.close()
    await h.edge()
    expect(h.host.openEligibility).not.toHaveBeenCalled()
    h.changeOwner()
    await h.deliver('service')
    expect(h.host.openEligibility).toHaveBeenCalledTimes(1)
    expect(h.host.send).not.toHaveBeenCalled()
  })
})
