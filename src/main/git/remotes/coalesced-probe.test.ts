import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve: (value: T) => void = () => {}
  let reject: (error: unknown) => void = () => {}
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle
    reject = fail
  })
  return { promise, resolve, reject }
}

describe('runCoalescedProbe', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('replaces a stale probe without letting the older cleanup remove its successor', async () => {
    const probes: CoalescedProbes<string> = new Map()
    const first = deferred<string>()
    const second = deferred<string>()
    const createProbe = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstRequest = runCoalescedProbe(probes, 'repo', createProbe, 60_000)
    vi.setSystemTime(1_060_001)
    const secondRequest = runCoalescedProbe(probes, 'repo', createProbe, 60_000)

    expect(createProbe).toHaveBeenCalledTimes(2)
    first.resolve('old')
    await expect(firstRequest).resolves.toBe('old')

    const joinedRequest = runCoalescedProbe(probes, 'repo', createProbe, 60_000)
    expect(createProbe).toHaveBeenCalledTimes(2)

    second.resolve('new')
    await expect(secondRequest).resolves.toBe('new')
    await expect(joinedRequest).resolves.toBe('new')
    expect(probes).toEqual(new Map())
  })

  it('removes a settled probe only when it still owns the key', async () => {
    const probes: CoalescedProbes<string> = new Map()
    const first = deferred<string>()
    const second = deferred<string>()
    const createProbe = vi
      .fn<() => Promise<string>>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const firstRequest = runCoalescedProbe(probes, 'repo', createProbe, 1)
    vi.advanceTimersByTime(2)
    const secondRequest = runCoalescedProbe(probes, 'repo', createProbe, 1)

    first.reject(new Error('old probe failed'))
    await expect(firstRequest).rejects.toThrow('old probe failed')
    expect(probes.get('repo')?.promise).toBe(second.promise)

    second.resolve('new')
    await expect(secondRequest).resolves.toBe('new')
  })
})
