import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueuedMessageEditLeases, QUEUED_MESSAGE_EDIT_LEASE_MS } from './queued-message-edit-leases'
import type { QueuedMessageRow } from './queued-message-table'

function card(messageId = 'card'): QueuedMessageRow {
  return {
    messageId,
    position: 1,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'hello' }] },
    fingerprint: 'base',
    state: 'waiting',
    holdReason: null,
    returnedReason: null,
    returnedRejection: null,
    consumedAs: null,
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

describe('queued edit leases', () => {
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
})
