import { describe, expect, it } from 'vitest'
import { BoundedLiveFreezeHistory } from './live-freeze-bounded-history.mjs'

describe('BoundedLiveFreezeHistory', () => {
  it('retains the newest entries in insertion order and counts the full run', () => {
    const history = new BoundedLiveFreezeHistory(3)

    for (let value = 1; value <= 7; value += 1) {
      history.add(value)
    }

    expect(history.values()).toEqual([5, 6, 7])
    expect(history.retainedCount).toBe(3)
    expect(history.totalCount).toBe(7)
  })

  it('rejects invalid retention limits', () => {
    expect(() => new BoundedLiveFreezeHistory(0)).toThrow('positive integer')
    expect(() => new BoundedLiveFreezeHistory(1.5)).toThrow('positive integer')
  })
})
