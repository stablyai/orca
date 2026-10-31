import { expect, it } from 'vitest'
import { highestUsageKey } from './highest-usage-key'

it('reads each total once instead of sorting all projects for one winner', () => {
  let reads = 0
  const entries = Array.from({ length: 2000 }, (_, index): [string, number] => {
    const pair: [string, number] = [String(index), (index * 173) % 2000]
    Object.defineProperty(pair, '1', {
      get() {
        reads += 1
        return (index * 173) % 2000
      }
    })
    return pair
  })
  const totals = new Map(entries)
  Object.defineProperty(totals, Symbol.iterator, { value: () => entries[Symbol.iterator]() })
  reads = 0
  const expected = [...totals].sort((left, right) => right[1] - left[1])[0][0]
  expect(reads).toBeGreaterThan(10000)
  reads = 0
  expect(highestUsageKey(totals)).toBe(expected)
  expect(reads).toBe(2000)
})
