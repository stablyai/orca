import { describe, expect, it, vi } from 'vitest'
import { GitStatusReadLeaseOwner } from './git-status-read-lease-owner'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

describe('GitStatusReadLeaseOwner', () => {
  it('cancels first and later callers without aborting a remaining lease', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const pending = deferred<string>()
    const load = vi.fn((_signal: AbortSignal) => pending.promise)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const thirdController = new AbortController()
    const firstError = new Error('first cancelled')
    const thirdError = new Error('third cancelled')

    const first = owner.lease('repo', firstController.signal, load)
    const second = owner.lease('repo', secondController.signal, load)
    const third = owner.lease('repo', thirdController.signal, load)
    firstController.abort(firstError)
    thirdController.abort(thirdError)

    await expect(first).rejects.toBe(firstError)
    await expect(third).rejects.toBe(thirdError)
    expect(load).toHaveBeenCalledOnce()
    expect(load.mock.calls[0][0].aborted).toBe(false)

    pending.resolve('fresh')
    await expect(second).resolves.toBe('fresh')
  })

  it('aborts underlying work when every live lease cancels and admits a fresh read', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const firstPending = deferred<string>()
    const secondPending = deferred<string>()
    const signals: AbortSignal[] = []
    const load = vi.fn((signal: AbortSignal) => {
      signals.push(signal)
      return signals.length === 1 ? firstPending.promise : secondPending.promise
    })
    const firstController = new AbortController()
    const secondController = new AbortController()

    const first = owner.lease('repo', firstController.signal, load)
    const second = owner.lease('repo', secondController.signal, load)
    firstController.abort(new Error('first cancelled'))
    expect(signals[0]?.aborted).toBe(false)
    secondController.abort(new Error('second cancelled'))

    await expect(first).rejects.toThrow('first cancelled')
    await expect(second).rejects.toThrow('second cancelled')
    expect(signals[0]?.aborted).toBe(true)

    const fresh = owner.lease('repo', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)
    secondPending.resolve('fresh')
    await expect(fresh).resolves.toBe('fresh')
    firstPending.reject(new Error('underlying aborted'))
    await Promise.resolve()
  })

  it('rejects a pre-aborted caller without starting or joining work', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const active = owner.lease('repo', undefined, load)
    const controller = new AbortController()
    const abortError = new Error('already cancelled')
    controller.abort(abortError)

    await expect(owner.lease('repo', controller.signal, load)).rejects.toBe(abortError)
    expect(load).toHaveBeenCalledOnce()

    pending.resolve('active')
    await expect(active).resolves.toBe('active')
  })

  it('cleans listeners and entries after success, failure, and cancellation', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const successController = new AbortController()
    const successRemove = vi.spyOn(successController.signal, 'removeEventListener')
    await expect(
      owner.lease('success', successController.signal, async () => 'success')
    ).resolves.toBe('success')
    expect(successRemove).toHaveBeenCalledOnce()

    const failureController = new AbortController()
    const failureRemove = vi.spyOn(failureController.signal, 'removeEventListener')
    const failure = new Error('failed')
    await expect(
      owner.lease('failure', failureController.signal, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(failureRemove).toHaveBeenCalledOnce()

    const cancelController = new AbortController()
    const cancelRemove = vi.spyOn(cancelController.signal, 'removeEventListener')
    const cancelPending = deferred<string>()
    const cancelled = owner.lease('cancel', cancelController.signal, () => cancelPending.promise)
    cancelController.abort()
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelRemove).toHaveBeenCalledOnce()

    const freshLoad = vi.fn(async () => 'fresh')
    await expect(owner.lease('success', undefined, freshLoad)).resolves.toBe('fresh')
    await expect(owner.lease('failure', undefined, freshLoad)).resolves.toBe('fresh')
    await expect(owner.lease('cancel', undefined, freshLoad)).resolves.toBe('fresh')
    expect(freshLoad).toHaveBeenCalledTimes(3)
    cancelPending.reject(new Error('underlying aborted'))
    await Promise.resolve()
  })

  it('invalidates joinability without breaking already-issued leases', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const firstPending = deferred<string>()
    const secondPending = deferred<string>()
    const load = vi
      .fn<(_signal: AbortSignal) => Promise<string>>()
      .mockReturnValueOnce(firstPending.promise)
      .mockReturnValueOnce(secondPending.promise)

    const first = owner.lease('repo', undefined, load)
    owner.invalidate()
    const second = owner.lease('repo', undefined, load)
    expect(load).toHaveBeenCalledTimes(2)

    firstPending.resolve('pre-mutation')
    secondPending.resolve('post-mutation')
    await expect(first).resolves.toBe('pre-mutation')
    await expect(second).resolves.toBe('post-mutation')
  })

  it('never caches a settled read', async () => {
    const owner = new GitStatusReadLeaseOwner<string>()
    const load = vi.fn(async () => `read-${load.mock.calls.length}`)

    await expect(owner.lease('repo', undefined, load)).resolves.toBe('read-1')
    await expect(owner.lease('repo', undefined, load)).resolves.toBe('read-2')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
