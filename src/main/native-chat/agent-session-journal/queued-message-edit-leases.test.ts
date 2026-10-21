import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessageEditLeases, QUEUED_MESSAGE_EDIT_LEASE_MS } from './queued-message-edit-leases'
import type { QueuedMessageRow } from './queued-message-table'

function card(messageId = 'card'): QueuedMessageRow {
  return {
    sessionId: 'folder-session',
    messageId,
    position: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    fingerprint: 'base',
    createdAt: 1,
    hostInstance: 'host-a',
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    settledAt: null,
    settledByOp: null,
    consumedAs: null,
    carriedFrom: null,
    queuedAt: null
  }
}
const desktop = { callerKey: 'desktop', editId: 'edit-1' }
const base = { messageId: 'card', fingerprint: 'base' }
let rows: QueuedMessageRow[]
let leases: QueuedMessageEditLeases
let clock: number
const wake = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  clock = 0
  rows = [card()]
  wake.mockReset()
  leases = new QueuedMessageEditLeases(
    () => rows,
    () => clock
  )
  leases.onDeadline(wake)
})
afterEach(() => {
  leases.dispose()
  vi.useRealTimers()
})

function advance(ms: number): void {
  clock += ms
  vi.advanceTimersByTime(ms)
}

describe('queued edit leases', () => {
  it('a repeated acquire answers the same lease without extending it', () => {
    expect(leases.acquire(desktop, base)).toMatchObject({ status: 'held', remainingMs: 120_000 })
    advance(30_000)
    expect(leases.acquire(desktop, base)).toMatchObject({ status: 'held', remainingMs: 90_000 })
  })

  it('acquire refuses a card that is gone or whose text moved on', () => {
    expect(leases.acquire(desktop, { ...base, fingerprint: 'stale' })).toEqual({
      status: 'changed'
    })
    expect(leases.acquire(desktop, { ...base, messageId: 'other' })).toEqual({ status: 'gone' })
    rows[0]!.state = 'dispatched'
    expect(leases.acquire(desktop, base)).toEqual({ status: 'gone' })
    expect(leases.heldIds().size).toBe(0)
  })

  it('expires on its own and wakes the queue with no other activity', () => {
    leases.acquire(desktop, base)
    advance(QUEUED_MESSAGE_EDIT_LEASE_MS - 1)
    expect(wake).not.toHaveBeenCalled()
    expect(leases.heldIds().has('card')).toBe(true)
    advance(1)
    expect(wake).toHaveBeenCalledOnce()
    expect(leases.heldIds().size).toBe(0)
  })

  it('renewal extends the deadline; a lapsed lease is not revived', () => {
    leases.acquire(desktop, base)
    advance(100_000)
    expect(leases.renew(desktop, 'card')).toMatchObject({ status: 'held', remainingMs: 120_000 })
    advance(119_999)
    expect(wake).not.toHaveBeenCalled()
    advance(1)
    expect(wake).toHaveBeenCalledOnce()
    expect(leases.renew(desktop, 'card')).toEqual({ status: 'expired' })
  })

  it("a renew that prunes another editor's lapsed lease before its timer runs still wakes the queue", () => {
    rows.push({ ...card('second'), position: 2, fingerprint: 'second-base' })
    const phone = { callerKey: 'phone', editId: 'edit-9' }
    leases.acquire(desktop, base)
    clock = 10_000
    leases.acquire(phone, { messageId: 'second', fingerprint: 'second-base' })
    // The first deadline has passed on the host clock; its timer is late and has not run.
    clock = QUEUED_MESSAGE_EDIT_LEASE_MS + 1
    expect(leases.renew(phone, 'second')).toMatchObject({ status: 'held' })
    expect([...leases.heldIds()]).toEqual(['second'])
    vi.advanceTimersByTime(QUEUED_MESSAGE_EDIT_LEASE_MS - 1)
    expect(wake).toHaveBeenCalledOnce()
  })

  it('release frees only the exact caller and edit, never another editor on the same card', () => {
    leases.acquire(desktop, base)
    leases.acquire({ callerKey: 'phone', editId: 'edit-1' }, base)
    leases.acquire({ ...desktop, editId: 'edit-2' }, base)
    leases.release(desktop, 'card')
    leases.release(desktop, 'card')
    expect(leases.heldIds().has('card')).toBe(true)
    leases.release({ callerKey: 'phone', editId: 'edit-1' }, 'card')
    expect(leases.heldIds().has('card')).toBe(true)
    leases.release({ ...desktop, editId: 'edit-2' }, 'card')
    expect(leases.heldIds().size).toBe(0)
  })

  it.each(['text changed', 'sent', 'deleted', 'handed off and returned'] as const)(
    'every read re-derives: a card whose %s holds nothing',
    (change) => {
      leases.acquire(desktop, base)
      const row = rows[0]!
      if (change === 'text changed') {
        row.fingerprint = 'newer'
      } else if (change === 'sent') {
        row.state = 'dispatched'
      } else if (change === 'deleted') {
        rows = []
      } else {
        Object.assign(row, { state: 'returned', consumedAs: 'submission-2' })
      }
      expect(leases.heldIds().size).toBe(0)
      expect(leases.renew(desktop, 'card')).toEqual({ status: 'expired' })
    }
  )

  it('a save retires every lease on the card; others stay', () => {
    rows.push(card('second'))
    leases.acquire(desktop, base)
    leases.acquire({ callerKey: 'phone', editId: 'edit-9' }, base)
    leases.acquire({ ...desktop, editId: 'edit-2' }, { ...base, messageId: 'second' })
    leases.retire('card')
    expect([...leases.heldIds()]).toEqual(['second'])
  })

  it('reads the rows it is given inside a transaction', () => {
    leases.acquire(desktop, base)
    expect(leases.heldIds([{ ...card(), state: 'withdrawn' }]).size).toBe(0)
  })

  it('dispose drops every lease and deadline; a closed handle grants none', () => {
    leases.acquire(desktop, base)
    leases.dispose()
    advance(QUEUED_MESSAGE_EDIT_LEASE_MS)
    expect(wake).not.toHaveBeenCalled()
    expect(leases.acquire(desktop, base)).toEqual({ status: 'gone' })
    expect(vi.getTimerCount()).toBe(0)
  })
})
