import { describe, expect, it } from 'vitest'
import { CELL_SEAT_FEED_PAGE_MAX, CellSeatLog } from './cell-seat-log.js'

function append(log: CellSeatLog, count: number): void {
  for (let index = 0; index < count; index += 1) {
    log.append({
      kind: 'join',
      userId: `user-${index}`,
      relayHostId: 'abcdefghijklmnop',
      epoch: 1,
      generation: 1,
      at: index
    })
  }
}

describe('cell seat log', () => {

  it('resyncs with a full snapshot once the cursor has fallen out of the ring', () => {
    const log = new CellSeatLog(4)
    append(log, 10)
    // Seqs 7..10 remain, so a cursor at 6 still continues and 5 does not.
    expect(log.read(6)).toMatchObject({ seq: 10, more: false })
    expect(log.read(5)).toMatchObject({ seq: 10, full: expect.any(Array) })
  })

  it('pages a long backlog and resumes from the returned cursor', () => {
    const log = new CellSeatLog(CELL_SEAT_FEED_PAGE_MAX * 2)
    append(log, CELL_SEAT_FEED_PAGE_MAX + 5)
    const first = log.read(0)
    expect(first).toMatchObject({ seq: CELL_SEAT_FEED_PAGE_MAX, more: true })
    expect('changes' in first && first.changes).toHaveLength(CELL_SEAT_FEED_PAGE_MAX)
    const second = log.read(first.seq)
    expect(second).toMatchObject({ seq: CELL_SEAT_FEED_PAGE_MAX + 5, more: false })
    expect('changes' in second && second.changes).toHaveLength(5)
  })
})

describe('cell seat log snapshot', () => {
  const change = (kind: 'join' | 'leave' | 'drain-only', generation: number, state?: 'drain-only') => ({
    kind,
    userId: 'user-1',
    relayHostId: 'abcdefghijklmnop',
    epoch: generation,
    generation,
    ...(state ? { state } : {}),
    at: generation
  })

  it('holds exactly what a reader applying every change by generation holds', () => {
    const log = new CellSeatLog(8)
    log.append(change('join', 1))
    log.append(change('join', 2))
    // The superseded generation's close lands after its successor joined.
    log.append(change('leave', 1))
    expect(log.seatCount()).toBe(1)
    log.append(change('drain-only', 2))
    expect(log.read(null)).toMatchObject({
      full: [{ userId: 'user-1', generation: 2, epoch: 2, state: 'drain-only', joinedAt: 2 }]
    })
    log.append(change('leave', 2))
    expect(log.seatCount()).toBe(0)
    // A drain notice for a host with no seat seats nothing.
    log.append(change('drain-only', 3))
    expect(log.read(null)).toMatchObject({ full: [] })
  })
})

describe('cell seat cursor', () => {

  it('never seats a booking, and remembers leavers for ten minutes for the full snapshot', () => {
    let now = 0
    const log = new CellSeatLog(64, () => now)
    const host = { userId: 'user-1', relayHostId: 'abcdefghijklmnop' }
    log.append({ kind: 'reserve', ...host, epoch: 4, generation: 0, reservedBy: 'd1', at: now })
    expect(log.seatCount()).toBe(0)
    log.append({ kind: 'join', ...host, epoch: 4, generation: 1, reservedBy: 'd1', at: now })
    expect(log.seatOf(host.userId, host.relayHostId)).toMatchObject({ epoch: 4, state: 'active' })
    now = 1_000
    log.append({ kind: 'leave', ...host, epoch: 4, generation: 1, closeCode: 1006, at: now })
    expect(log.recentlyLeftOf(host.userId, host.relayHostId)).toEqual({ ...host, epoch: 4, closeCode: 1006, at: 1_000 })
    const page = log.read(null)
    expect('full' in page && page.recentlyLeft).toEqual([{ ...host, epoch: 4, closeCode: 1006, at: 1_000 }])
    now = 1_000 + 10 * 60_000
    expect(log.recentlyLeftOf(host.userId, host.relayHostId)).toBeUndefined()
  })

  it('sends only the newest page of leavers in a full snapshot', () => {
    const log = new CellSeatLog(CELL_SEAT_FEED_PAGE_MAX * 4, () => 0)
    const leavers = CELL_SEAT_FEED_PAGE_MAX + 5
    for (let index = 0; index < leavers; index += 1) {
      const host = { userId: `user-${index}`, relayHostId: 'abcdefghijklmnop', epoch: 1, generation: 1 }
      log.append({ kind: 'join', ...host, at: 0 })
      log.append({ kind: 'leave', ...host, closeCode: 1006, at: 0 })
    }
    const page = log.read(null)
    const left = 'full' in page ? page.recentlyLeft : []
    expect(left).toHaveLength(CELL_SEAT_FEED_PAGE_MAX)
    expect(left.at(-1)?.userId).toBe(`user-${leavers - 1}`)
    // The cell itself still remembers the oldest.
    expect(log.recentlyLeftOf('user-0', 'abcdefghijklmnop')).toBeDefined()
  })
})

