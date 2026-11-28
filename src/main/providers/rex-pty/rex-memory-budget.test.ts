import { describe, expect, it, vi } from 'vitest'
import { RexMemoryBudget, RexJobBudget } from './rex-memory-budget'
import { RexPendingRestores } from './rex-pending-restores'

describe('Rex memory admission', () => {
  it('shares a byte limit and an object limit; releases exactly once', () => {
    const budget = new RexMemoryBudget(100, 2)
    const a = budget.reserve(60)!
    expect(budget.reserve(41)).toBeUndefined()
    const b = budget.reserve(40)!
    expect(budget.reserve(0)).toBeUndefined()
    expect(budget.usage()).toEqual({ bytes: 100, objects: 2 })
    a()
    a()
    expect(budget.usage()).toEqual({ bytes: 40, objects: 1 })
    expect(budget.reserve(-1)).toBeUndefined()
    b()
    expect(budget.usage()).toEqual({ bytes: 0, objects: 0 })
  })
  it('admits jobs in FIFO order, rejects excess and releases a slot once', async () => {
    const jobs = new RexJobBudget(1, 2)
    const a = await jobs.acquire()
    const b = jobs.acquire()
    const c = jobs.acquire()
    await expect(jobs.acquire()).rejects.toThrow('queue full')
    a()
    a()
    const releaseB = await b
    let admitted = false
    void c.then(() => {
      admitted = true
    })
    await Promise.resolve()
    expect(admitted).toBe(false)
    releaseB()
    const releaseC = await c
    releaseC()
    const d = await jobs.acquire()
    d()
  })
  it('expires waiting work without leaking a slot', async () => {
    vi.useFakeTimers()
    try {
      const jobs = new RexJobBudget(1, 1, 100)
      const release = await jobs.acquire()
      const waiting = expect(jobs.acquire()).rejects.toThrow('admission timed out')
      await vi.advanceTimersByTimeAsync(100)
      await waiting
      release()
      const next = await jobs.acquire()
      next()
    } finally {
      vi.useRealTimers()
    }
  })
  it('expires abandoned restore tails and cancels activated or replaced timers', async () => {
    vi.useFakeTimers()
    try {
      const pending = new RexPendingRestores(100)
      const expired = vi.fn()
      const value = { tail: Buffer.from('tail'), nonce: 1n, continuation: Buffer.alloc(0) }
      pending.set('a', value, expired)
      pending.delete('a')
      pending.set('b', value, expired)
      await vi.advanceTimersByTimeAsync(100)
      expect(expired).toHaveBeenCalledTimes(1)
      expect(pending.has('a')).toBe(false)
      expect(pending.get('b')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
