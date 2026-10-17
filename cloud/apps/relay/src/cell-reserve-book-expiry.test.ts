import { describe, expect, it, vi } from 'vitest'
import { CellReserveBook, type BookingCapacity, type ReserveContext } from './cell-reserve-book.js'

const context: ReserveContext = { mode: 'reserve', draining: false, seatedEpoch: () => undefined }
const host = 'abcdefghijklmnop'
const item = (userId: string, epoch = 2, ttlMs = 30_000) => ({
  userId,
  relayHostId: host,
  epoch,
  ttlMs,
  sticky: true
})

function setup() {
  let now = 0
  const released: string[] = []
  let nextId = 0
  const capacity: BookingCapacity = {
    canReserve: () => true,
    tryReserve: () => {
      const id = String(nextId++)
      let held = true
      return {
        release() {
          if (held) released.push(id)
          held = false
        }
      }
    }
  }
  const book = new CellReserveBook(
    capacity,
    () => 10,
    () => now
  )
  return {
    book,
    released,
    at: (value: number) => {
      now = value
    }
  }
}

function countVisits(operation: () => void): number {
  let visits = 0
  const entries = Map.prototype[Symbol.iterator]
  const scan = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
    this: Map<unknown, unknown>
  ) {
    const iterator = entries.call(this)
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const result = next()
      if (!result.done) visits++
      return result
    }
    return iterator
  })
  try {
    operation()
    return visits
  } finally {
    scan.mockRestore()
  }
}

describe('cell reserve expiry scans', () => {
  it('does not revisit live bookings for a full sticky renewal request', () => {
    const { book } = setup()
    for (let index = 0; index < 2_840; index++) book.reserve('d1', item(`user-${index}`), context)
    const visits = countVisits(() => {
      for (let index = 0; index < 64; index++) book.reserve('d2', item(`user-${index}`), context)
    })
    expect(visits).toBe(0)
    expect(book.count()).toBe(2_840)
  })

  it('releases every expired booking in insertion order at the exact deadline', () => {
    const { book, released, at } = setup()
    book.reserve('d1', item('a', 2, 300), context)
    book.reserve('d1', item('b', 2, 100), context)
    book.reserve('d1', item('c', 2, 200), context)
    at(99)
    book.sweep()
    expect(released).toEqual([])
    at(100)
    book.sweep()
    expect(released).toEqual(['1'])
    at(200)
    book.sweep()
    expect(released).toEqual(['1', '2'])
    at(300)
    book.sweep()
    expect(released).toEqual(['1', '2', '0'])
    expect(book.count()).toBe(0)
  })

  it('retains renewed bookings and begins scanning again at their extended deadline', () => {
    const { book, released, at } = setup()
    book.reserve('d1', item('a', 2, 100), context)
    book.reserve('d1', item('b', 2, 200), context)
    at(50)
    book.reserve('d2', item('a', 2, 300), context)
    at(100)
    book.sweep()
    expect(released).toEqual([])
    at(199)
    book.sweep()
    at(200)
    book.sweep()
    expect(released).toEqual(['1'])
    at(350)
    book.sweep()
    expect(released).toEqual(['1', '0'])
  })

  it('tracks an earlier replacement and leaves takes, handoffs and clear unchanged', () => {
    const { book, released, at } = setup()
    book.reserve('d1', item('a'), context)
    book.reserve('d1', item('b'), context)
    at(10)
    book.reserve('d2', item('a', 3, 20), context)
    book.handOff('b', host)
    book.handOff('b', host)
    expect(released).toEqual(['1'])
    at(30)
    book.sweep()
    expect(released).toEqual(['1', '0'])
    expect(book.take('b', host, 2)).toMatchObject({ epoch: 2 })
    book.reserve('d1', item('c'), context)
    book.clear()
    expect(book.count()).toBe(0)
    expect(released).toEqual(['1', '0', '2'])
    book.reserve('d1', item('d', 2, 10), context)
    at(40)
    book.sweep()
    expect(released).toEqual(['1', '0', '2', '3'])
  })

  it('still sweeps before off, draining, and dry-run refusals', () => {
    for (const next of [
      { context: { ...context, mode: 'db' as const }, dryRun: false },
      { context: { ...context, draining: true }, dryRun: false },
      { context, dryRun: true }
    ]) {
      const { book, released, at } = setup()
      book.reserve('d1', item('a', 2, 10), context)
      at(10)
      book.reserve('d1', item('b'), next.context, next.dryRun)
      expect(released).toEqual(['0'])
      expect(book.count()).toBe(0)
    }
  })

  it('retries a sweep after a booking release throws', () => {
    let failures = 1
    const released: number[] = []
    let nextId = 0
    const book = new CellReserveBook(
      {
        canReserve: () => true,
        tryReserve: () => {
          const id = nextId++
          return {
            release: () => {
              if (failures-- > 0) throw new Error('release failed')
              released.push(id)
            }
          }
        }
      },
      () => 10,
      () => 0
    )
    book.reserve('d1', item('a', 2, 10), context)
    book.reserve('d1', item('b', 2, 10), context)
    expect(() => book.sweep(10)).toThrow('release failed')
    expect(book.count()).toBe(1)
    book.sweep(10)
    expect(released).toEqual([1])
    expect(book.count()).toBe(0)
  })

  it('preserves direct callers supplying zero, negative, or NaN expiry durations', () => {
    for (const ttlMs of [0, -1, Number.NaN]) {
      const { book, released } = setup()
      book.reserve('d1', item('a', 2, ttlMs), context)
      book.reserve('d1', item('b'), context)
      expect(released).toEqual(['0'])
      expect(book.count()).toBe(1)
    }
  })

  it('still sweeps a sticky booking whose direct caller renewed it with NaN', () => {
    const { book, released } = setup()
    book.reserve('d1', item('a'), context)
    book.reserve('d1', item('a', 2, Number.NaN), context)
    book.reserve('d1', item('b'), context)
    expect(released).toEqual(['0'])
    expect(book.count()).toBe(1)
  })
})
