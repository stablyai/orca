import { vi } from 'vitest'

// Count native work only inside the synchronous production boundary, delegating every operation.
export function countAttentionCollectionWork<T>(
  run: () => T,
  accepts: (values: readonly unknown[]) => boolean = () => true
) {
  const counts = {
    callbacks: 0,
    copies: 0,
    membership: 0,
    mapEntries: 0,
    filter: 0,
    map: 0,
    replayCallbacks: 0,
    replayFilters: 0,
    mapValues: 0,
    mapKeys: 0
  }
  let measuring = false
  const stops: (() => void)[] = []
  for (const name of ['filter', 'find', 'findLast', 'some', 'every', 'map', 'flatMap'] as const) {
    const original: (
      this: unknown[],
      callback: (value: unknown, index: number, array: unknown[]) => unknown,
      thisArg?: unknown
    ) => unknown = Array.prototype[name]
    Object.defineProperty(Array.prototype, name, {
      value: function (
        this: unknown[],
        callback: (value: unknown, index: number, array: unknown[]) => unknown,
        thisArg?: unknown
      ) {
        const counted = measuring && accepts(this)
        return original.call(this, (value, index, array) => {
          if (counted) {
            counts.callbacks += 1
            if (isAttentionReplay(this)) {
              counts.replayCallbacks += 1
              if (name === 'filter') {
                counts.replayFilters += 1
              }
            }
            if (name === 'filter') {
              counts.filter += 1
            }
            if (name === 'map') {
              counts.map += 1
            }
          }
          return callback.call(thisArg, value, index, array)
        })
      }
    })
    stops.push(() => {
      Object.defineProperty(Array.prototype, name, { value: original })
    })
  }
  const sort = Array.prototype.sort
  const sortSpy = vi.spyOn(Array.prototype, 'sort').mockImplementation(function (
    this: unknown[],
    compare
  ) {
    const counted = measuring && accepts(this)
    return sort.call(
      this,
      compare &&
        ((a, b) => {
          if (counted) {
            counts.callbacks += 1
          }
          return compare(a, b)
        })
    )
  })
  stops.push(() => sortSpy.mockRestore())
  const includes = Array.prototype.includes
  const includesSpy = vi.spyOn(Array.prototype, 'includes').mockImplementation(function (
    this: unknown[],
    value,
    from
  ) {
    if (!measuring || !accepts(this)) {
      return includes.call(this, value, from)
    }
    const receiver = new Proxy(this, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) {
          counts.membership += 1
        }
        return key === 'length' ? target.length : target[Number(key)]
      }
    })
    return includes.call(receiver, value, from)
  })
  stops.push(() => includesSpy.mockRestore())
  const arrayIterator = Array.prototype[Symbol.iterator]
  Array.prototype[Symbol.iterator] = function* (): ArrayIterator<unknown> {
    const counted = measuring && accepts(this)
    for (const value of arrayIterator.call(this)) {
      if (counted) {
        counts.copies += 1
      }
      yield value
    }
  }
  stops.push(() => {
    Array.prototype[Symbol.iterator] = arrayIterator
  })
  const slice = Array.prototype.slice
  const sliceSpy = vi.spyOn(Array.prototype, 'slice').mockImplementation(function (
    this: unknown[],
    start,
    end
  ) {
    const result = slice.call(this, start, end)
    if (measuring && accepts(this)) {
      counts.copies += result.length
    }
    return result
  })
  stops.push(() => sliceSpy.mockRestore())
  const values = Map.prototype.values
  const valuesSpy = vi.spyOn(Map.prototype, 'values').mockImplementation(function* (
    this: Map<unknown, unknown>
  ): MapIterator<unknown> {
    for (const value of values.call(this)) {
      if (measuring) {
        counts.mapValues += 1
      }
      yield value
    }
  })
  stops.push(() => valuesSpy.mockRestore())
  const keys = Map.prototype.keys
  const keysSpy = vi.spyOn(Map.prototype, 'keys').mockImplementation(function* (
    this: Map<unknown, unknown>
  ): MapIterator<unknown> {
    for (const key of keys.call(this)) {
      if (measuring) {
        counts.mapKeys += 1
      }
      yield key
    }
  })
  stops.push(() => keysSpy.mockRestore())
  const entries = Map.prototype[Symbol.iterator]
  const entriesSpy = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
    this: Map<unknown, unknown>
  ): MapIterator<[unknown, unknown]> {
    for (const entry of entries.call(this)) {
      if (measuring) {
        counts.mapEntries += 1
      }
      yield entry
    }
  })
  stops.push(() => entriesSpy.mockRestore())
  try {
    measuring = true
    return { result: run(), counts }
  } finally {
    measuring = false
    for (const stop of stops.toReversed()) {
      stop()
    }
  }
}

export function isAttentionReplay(values: readonly unknown[]): boolean {
  const first = values[0]
  return !!first && typeof first === 'object' && 'notificationSeq' in first && 'type' in first
}
