import { describe, expect, it, vi } from 'vitest'
import { TerminalFocusNavigationCoalescer } from './terminal-focus-navigation-coalescer'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('TerminalFocusNavigationCoalescer', () => {
  it('runs a single job to completion', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<string>()
    const result = await coalescer.run({
      key: 'term_a',
      run: async () => 'full-a',
      resolveSuperseded: () => 'superseded-a'
    })
    expect(result).toBe('full-a')
    expect(coalescer.getState()).toMatchObject({
      running: false,
      activeKey: null,
      pendingKey: null
    })
  })

  it('serializes concurrent focuses and latest-wins drops intermediate pending', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<string>()
    const aGate = deferred<void>()
    let aStarted = false

    const runA = vi.fn(async (ctx: { isCurrent: () => boolean }) => {
      aStarted = true
      await aGate.promise
      if (!ctx.isCurrent()) {
        return 'obsolete-a'
      }
      return 'full-a'
    })
    const runB = vi.fn(async () => 'full-b')
    const runC = vi.fn(async () => 'full-c')
    const superB = vi.fn(() => 'super-b')

    const pA = coalescer.run({
      key: 'term_a',
      run: runA,
      resolveSuperseded: (completed) => completed ?? 'super-a'
    })
    await vi.waitFor(() => {
      expect(aStarted).toBe(true)
    })

    const pB = coalescer.run({
      key: 'term_b',
      run: runB,
      resolveSuperseded: superB
    })
    const pC = coalescer.run({
      key: 'term_c',
      run: runC,
      resolveSuperseded: () => 'super-c'
    })

    await expect(pB).resolves.toBe('super-b')
    expect(superB).toHaveBeenCalledTimes(1)
    expect(runB).not.toHaveBeenCalled()

    aGate.resolve()
    await expect(pA).resolves.toBe('obsolete-a')
    await expect(pC).resolves.toBe('full-c')
    expect(runC).toHaveBeenCalledTimes(1)
  })

  it('bounds host navigation to one full run under a parallel storm', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<number>()
    let inFlight = 0
    let maxInFlight = 0
    let fullRuns = 0

    const makeJob = (key: string) =>
      coalescer.run({
        key,
        run: async (ctx) => {
          if (!ctx.isCurrent()) {
            return -1
          }
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          fullRuns += 1
          await new Promise((r) => setTimeout(r, 5))
          inFlight -= 1
          if (!ctx.isCurrent()) {
            return -1
          }
          return fullRuns
        },
        resolveSuperseded: () => -1
      })

    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => makeJob(`term_${i}`)))

    expect(maxInFlight).toBe(1)
    expect(fullRuns).toBeLessThanOrEqual(2)
    expect(fullRuns).toBeGreaterThanOrEqual(1)
    expect(results.filter((r) => r === -1).length).toBeGreaterThanOrEqual(14)
    expect(results.some((r) => r > 0)).toBe(true)
  })

  it('skips claiming navigation when a newer focus arrives mid-run', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<{ id: string; navigated: boolean }>()
    const aGate = deferred<void>()
    let aStarted = false

    const pA = coalescer.run({
      key: 'term_a',
      run: async (ctx) => {
        aStarted = true
        await aGate.promise
        return { id: 'a', navigated: ctx.isCurrent() }
      },
      resolveSuperseded: () => ({ id: 'a', navigated: false })
    })
    await vi.waitFor(() => {
      expect(aStarted).toBe(true)
    })

    const pB = coalescer.run({
      key: 'term_b',
      run: async () => ({ id: 'b', navigated: true }),
      resolveSuperseded: () => ({ id: 'b', navigated: false })
    })

    aGate.resolve()
    await expect(pA).resolves.toEqual({ id: 'a', navigated: false })
    await expect(pB).resolves.toEqual({ id: 'b', navigated: true })
  })

  it('marks a synchronous run superseded when it queues a newer job before settling', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<{
      id: string
      navigated: boolean
    }>()
    let latest!: Promise<{ id: string; navigated: boolean }>

    const first = coalescer.run({
      key: 'term_a',
      run: async () => {
        latest = coalescer.run({
          key: 'term_b',
          run: async () => ({ id: 'b', navigated: true }),
          resolveSuperseded: () => ({ id: 'b', navigated: false })
        })
        return { id: 'a', navigated: true }
      },
      resolveSuperseded: (completed) => ({
        id: completed?.id ?? 'a',
        navigated: false
      })
    })

    await expect(first).resolves.toEqual({ id: 'a', navigated: false })
    await expect(latest).resolves.toEqual({ id: 'b', navigated: true })
  })

  it('propagates run failures without stranding the queue', async () => {
    const coalescer = new TerminalFocusNavigationCoalescer<string>()
    const aGate = deferred<void>()
    let aStarted = false

    const pA = coalescer.run({
      key: 'term_a',
      run: async () => {
        aStarted = true
        await aGate.promise
        throw new Error('boom')
      },
      resolveSuperseded: () => 'super-a'
    })
    await vi.waitFor(() => {
      expect(aStarted).toBe(true)
    })

    const pB = coalescer.run({
      key: 'term_b',
      run: async () => 'full-b',
      resolveSuperseded: () => 'super-b'
    })

    aGate.resolve()
    // A is obsolete when it fails after B enqueued — settles as superseded, not boom.
    await expect(pA).resolves.toBe('super-a')
    await expect(pB).resolves.toBe('full-b')
    expect(coalescer.getState().running).toBe(false)
  })
})
