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
