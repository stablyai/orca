import { describe, expect, it } from 'vitest'
import { CellReserveBook, type BookingCapacity, type ReserveContext } from './cell-reserve-book.js'

function units(limit: number): BookingCapacity & { held: () => number } {
  let held = 0
  return {
    held: () => held,
    canReserve: () => held < limit,
    tryReserve: () => {
      if (held >= limit) return null
      held += 1
      let released = false
      return {
        release: () => {
          if (released) return
          released = true
          held -= 1
        }
      }
    }
  }
}

const reserveMode: ReserveContext = { mode: 'reserve', draining: false, seatedEpoch: () => undefined }

function item(userId: string, epoch = 2, extra: { sticky?: boolean; ttlMs?: number } = {}) {
  return { userId, relayHostId: 'abcdefghijklmnop', epoch, ttlMs: extra.ttlMs ?? 30_000, ...extra }
}

describe('cell reserve book', () => {
  it('books up to the capacity and answers full past it', () => {
    let now = 0
    const capacity = units(2)
    const book = new CellReserveBook(capacity, () => 100, () => now)
    expect(book.reserve('d1', item('a'), reserveMode)).toEqual({ outcome: 'ok' })
    expect(book.reserve('d1', item('b'), reserveMode)).toEqual({ outcome: 'ok' })
    expect(book.reserve('d1', item('c'), reserveMode)).toEqual({ outcome: 'full' })
    expect(capacity.held()).toBe(2)
    now = 31_000
    book.sweep()
    expect(capacity.held()).toBe(0)
    expect(book.count()).toBe(0)
  })

  it('refuses past the intake budget and refills at the configured rate', () => {
    let now = 0
    const book = new CellReserveBook(units(1_000), () => 2, () => now, 3)
    const outcomes = ['a', 'b', 'c', 'd'].map((user) => book.reserve('d1', item(user), reserveMode))
    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['ok', 'ok', 'ok', 'intake'])
    now = 500
    expect(book.reserve('d1', item('e'), reserveMode).outcome).toBe('ok')
    expect(book.reserve('d1', item('f'), reserveMode).outcome).toBe('intake')
  })

  it('answers seated-newer when the host is seated or booked at an equal or higher epoch', () => {
    const book = new CellReserveBook(units(10), () => 100)
    const seatedAt5: ReserveContext = { ...reserveMode, seatedEpoch: () => 5 }
    expect(book.reserve('d1', item('a', 5), seatedAt5)).toEqual({ outcome: 'seated-newer', epoch: 5 })
    expect(book.reserve('d1', item('b', 3), reserveMode).outcome).toBe('ok')
    expect(book.reserve('d2', item('b', 3), reserveMode)).toEqual({ outcome: 'seated-newer', epoch: 3 })
    expect(book.reserve('d2', item('b', 4), reserveMode).outcome).toBe('ok')
    expect(book.count()).toBe(1)
  })

  it('lets a sticky re-booking skip the intake bucket but never the cap', () => {
    const capacity = units(1)
    const book = new CellReserveBook(capacity, () => 0, () => 0, 1)
    expect(book.reserve('d1', item('a'), reserveMode).outcome).toBe('ok')
    expect(book.reserve('d1', item('b'), reserveMode).outcome).toBe('full')
    expect(book.reserve('d1', item('c', 2, { sticky: true }), reserveMode).outcome).toBe('full')
    expect(book.take('a', 'abcdefghijklmnop', 2)).not.toBeNull()
    expect(book.reserve('d1', item('c', 2, { sticky: true }), reserveMode).outcome).toBe('ok')
  })

  it('answers ok for a sticky re-booking of a host already seated at that epoch, booking nothing', () => {
    const capacity = units(1)
    const book = new CellReserveBook(capacity, () => 0, () => 0, 0)
    const seated: ReserveContext = { ...reserveMode, seatedEpoch: () => 4 }
    expect(book.reserve('d1', item('a', 4, { sticky: true }), seated).outcome).toBe('ok')
    expect(capacity.held()).toBe(0)
  })

  it('consumes a booking once, only at its own epoch, and releases its unit', () => {
    const capacity = units(5)
    const book = new CellReserveBook(capacity, () => 100)
    book.reserve('d7', item('a', 9), reserveMode)
    expect(book.take('a', 'abcdefghijklmnop', 8)).toBeNull()
    expect(book.take('a', 'abcdefghijklmnop', 9)).toMatchObject({ epoch: 9, directorId: 'd7' })
    expect(book.take('a', 'abcdefghijklmnop', 9)).toBeNull()
    expect(capacity.held()).toBe(0)
  })

  it('answers off outside reserve mode, draining while draining, and dry runs book nothing', () => {
    const capacity = units(5)
    const book = new CellReserveBook(capacity, () => 100)
    const databaseMode: ReserveContext = { ...reserveMode, mode: 'db' }
    expect(book.reserve('d1', item('a'), databaseMode).outcome).toBe('off')
    expect(book.reserve('d1', item('a'), databaseMode, true).outcome).toBe('ok')
    expect(book.reserve('d1', item('a'), { ...reserveMode, draining: true }).outcome).toBe('draining')
    expect(capacity.held()).toBe(0)
    expect(book.count()).toBe(0)
  })

  it('hands a lower-epoch booking unit to its successor rather than taking a second', () => {
    const capacity = units(1)
    const book = new CellReserveBook(capacity, () => 100)
    expect(book.reserve('d1', item('a', 2), reserveMode).outcome).toBe('ok')
    expect(book.reserve('d2', item('a', 3), reserveMode).outcome).toBe('ok')
    expect(capacity.held()).toBe(1)
    book.clear()
    expect(capacity.held()).toBe(0)
  })

  it('hands a booking unit to the host upgrade, so the host counts once until its hello', () => {
    const capacity = units(2)
    const book = new CellReserveBook(capacity, () => 100)
    book.reserve('d1', item('a', 2), reserveMode)
    expect(capacity.held()).toBe(1)
    book.handOff('a', 'abcdefghijklmnop')
    book.handOff('a', 'abcdefghijklmnop')
    expect(capacity.held()).toBe(0)
    // Still a booking for the hello, at its own epoch only.
    expect(book.has('a', 'abcdefghijklmnop')).toBe(true)
    expect(book.take('a', 'abcdefghijklmnop', 3)).toBeNull()
    // A newer booking for a handed-off host needs a unit of its own.
    expect(book.reserve('d1', item('a', 3), reserveMode).outcome).toBe('ok')
    expect(capacity.held()).toBe(1)
    expect(book.take('a', 'abcdefghijklmnop', 3)).toMatchObject({ epoch: 3 })
    expect(capacity.held()).toBe(0)
  })
})
