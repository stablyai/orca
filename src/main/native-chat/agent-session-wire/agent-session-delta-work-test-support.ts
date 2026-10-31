import { vi } from 'vitest'

/** Isolate shared snapshot work from the callers' journal and routing maps. */
export function measureDeltaSnapshotWork() {
  let visits = 0
  let reads = 0
  const isSnapshot = (value: unknown) =>
    value !== null && typeof value === 'object' && 'chunks' in value && 'retainedBytes' in value
  function count<T>(iterator: MapIterator<T>, selected: (value: T) => unknown): MapIterator<T> {
    const next = iterator.next.bind(iterator)
    iterator.next = () => {
      const result = next()
      if (!result.done && isSnapshot(selected(result.value))) {
        visits++
      }
      return result
    }
    return iterator
  }
  const values = Map.prototype.values
  const entries = Map.prototype[Symbol.iterator]
  const get = Map.prototype.get
  const spies = [
    vi.spyOn(Map.prototype, 'values').mockImplementation(function (this: Map<unknown, unknown>) {
      return count(values.call(this), (value) => value)
    }),
    vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function (
      this: Map<unknown, unknown>
    ) {
      return count(entries.call(this), (entry) => entry[1])
    }),
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (
      this: Map<unknown, unknown>,
      key: unknown
    ) {
      const value = get.call(this, key)
      if (isSnapshot(value)) {
        reads++
      }
      return value
    })
  ]
  return {
    work: () => visits + reads,
    reset: () => {
      visits = 0
      reads = 0
    },
    stop: () => spies.forEach((spy) => spy.mockRestore())
  }
}
