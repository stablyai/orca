import { describe, expect, it, beforeEach } from 'vitest'
import { SshGitProvider } from './ssh-git-provider'
import {
  createMockMux,
  waitForRequestCount,
  type MockMultiplexer
} from './ssh-git-provider-test-harness'

function deferredPromise<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

describe('SshGitProvider status read leases', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('shares one status RPC across distinct caller signals', async () => {
    const pending = deferredPromise<{
      entries: never[]
      conflictOperation: 'unknown'
    }>()
    mux.request.mockReturnValue(pending.promise)
    const controllers = Array.from({ length: 10 }, () => new AbortController())

    const reads = controllers.map((controller) =>
      provider.getStatus('/home/user/repo', { signal: controller.signal })
    )
    await waitForRequestCount(mux.request, 1)

    expect(mux.request).toHaveBeenCalledTimes(1)
    pending.resolve({ entries: [], conflictOperation: 'unknown' })
    await expect(Promise.all(reads)).resolves.toHaveLength(10)
  })

  it('isolates first and later caller cancellation while a status lease remains', async () => {
    const pending = deferredPromise<{
      entries: never[]
      conflictOperation: 'unknown'
    }>()
    mux.request.mockReturnValue(pending.promise)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const thirdController = new AbortController()
    const firstError = new Error('first caller cancelled')
    const thirdError = new Error('third caller cancelled')

    const first = provider.getStatus('/home/user/repo', { signal: firstController.signal })
    const second = provider.getStatus('/home/user/repo', { signal: secondController.signal })
    const third = provider.getStatus('/home/user/repo', { signal: thirdController.signal })
    await waitForRequestCount(mux.request, 1)
    const sharedSignal = mux.request.mock.calls[0][2].signal as AbortSignal

    firstController.abort(firstError)
    thirdController.abort(thirdError)
    await expect(first).rejects.toBe(firstError)
    await expect(third).rejects.toBe(thirdError)
    expect(sharedSignal.aborted).toBe(false)

    pending.resolve({ entries: [], conflictOperation: 'unknown' })
    await expect(second).resolves.toEqual({ entries: [], conflictOperation: 'unknown' })
  })

  it('cancels the underlying status RPC after its last live lease aborts', async () => {
    const firstPending = deferredPromise<{
      entries: never[]
      conflictOperation: 'unknown'
    }>()
    mux.request.mockReturnValueOnce(firstPending.promise)
    const firstController = new AbortController()
    const secondController = new AbortController()
    const firstError = new Error('first caller cancelled')
    const secondError = new Error('second caller cancelled')
    const first = provider.getStatus('/home/user/repo', { signal: firstController.signal })
    const second = provider.getStatus('/home/user/repo', { signal: secondController.signal })
    await waitForRequestCount(mux.request, 1)
    const sharedSignal = mux.request.mock.calls[0][2].signal as AbortSignal
    sharedSignal.addEventListener('abort', () => firstPending.reject(sharedSignal.reason), {
      once: true
    })

    firstController.abort(firstError)
    await expect(first).rejects.toBe(firstError)
    expect(sharedSignal.aborted).toBe(false)
    secondController.abort(secondError)
    await expect(second).rejects.toBe(secondError)
    expect(sharedSignal.aborted).toBe(true)

    mux.request.mockResolvedValueOnce({ entries: [], conflictOperation: 'unknown' })
    await expect(provider.getStatus('/home/user/repo')).resolves.toMatchObject({ entries: [] })
    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('rejects pre-aborted status callers without starting or joining an RPC', async () => {
    const controller = new AbortController()
    const abortError = new Error('already cancelled')
    controller.abort(abortError)

    await expect(provider.getStatus('/home/user/repo', { signal: controller.signal })).rejects.toBe(
      abortError
    )
    expect(mux.request).not.toHaveBeenCalled()

    const pending = deferredPromise<{
      entries: never[]
      conflictOperation: 'unknown'
    }>()
    mux.request.mockReturnValueOnce(pending.promise)
    const active = provider.getStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 1)
    await expect(provider.getStatus('/home/user/repo', { signal: controller.signal })).rejects.toBe(
      abortError
    )
    expect(mux.request).toHaveBeenCalledTimes(1)

    pending.resolve({ entries: [], conflictOperation: 'unknown' })
    await active
  })

  it('starts fresh status RPCs after result and error settlement', async () => {
    const status = { entries: [], conflictOperation: 'unknown' as const }
    mux.request.mockResolvedValueOnce(status)

    await expect(provider.getStatus('/home/user/repo')).resolves.toBe(status)
    const failure = new Error('relay status failed')
    mux.request.mockRejectedValueOnce(failure)
    await expect(provider.getStatus('/home/user/repo')).rejects.toBe(failure)
    mux.request.mockResolvedValueOnce(status)
    await expect(provider.getStatus('/home/user/repo')).resolves.toBe(status)

    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('isolates status reads by worktree and output-affecting options', async () => {
    const pendingRequests = Array.from({ length: 8 }, () =>
      deferredPromise<{ entries: never[]; conflictOperation: 'unknown' }>()
    )
    mux.request.mockImplementation(
      () => pendingRequests[mux.request.mock.calls.length - 1]?.promise
    )

    const reads = [
      provider.getStatus('/home/user/repo'),
      provider.getStatus('/home/user/other'),
      provider.getStatus('/home/user/repo', { includeIgnored: true }),
      provider.getStatus('/home/user/repo', { includeLineStats: false }),
      provider.getStatus('/home/user/repo', {
        bypassEffectiveUpstreamNegativeCache: true
      }),
      provider.getStatus('/home/user/repo', { reuseLineStats: true }),
      provider.getStatus('/home/user/repo', { admissionTier: 'background' }),
      provider.getStatus('/home/user/repo', { admissionTier: 'interactive' })
    ]
    await waitForRequestCount(mux.request, 8)

    expect(mux.request.mock.calls.map(([, payload]) => payload)).toEqual([
      { worktreePath: '/home/user/repo' },
      { worktreePath: '/home/user/other' },
      { worktreePath: '/home/user/repo', includeIgnored: true },
      { worktreePath: '/home/user/repo', includeLineStats: false },
      {
        worktreePath: '/home/user/repo',
        bypassEffectiveUpstreamNegativeCache: true
      },
      { worktreePath: '/home/user/repo', reuseLineStats: true },
      { worktreePath: '/home/user/repo', admissionTier: 'background' },
      { worktreePath: '/home/user/repo', admissionTier: 'interactive' }
    ])
    pendingRequests.forEach((pending) =>
      pending.resolve({ entries: [], conflictOperation: 'unknown' })
    )
    await Promise.all(reads)
  })

  it('isolates status reads by branch-line-total fork point', async () => {
    const pendingRequests = Array.from({ length: 3 }, () =>
      deferredPromise<{ entries: never[]; conflictOperation: 'unknown' }>()
    )
    mux.request.mockImplementation(
      () => pendingRequests[mux.request.mock.calls.length - 1]?.promise
    )

    // Why: the response shape differs per fork point, so a poll that omitted the base
    // must never serve a refresh that asked for it (the chip would blank or go stale).
    const reads = [
      provider.getStatus('/home/user/repo'),
      provider.getStatus('/home/user/repo', { branchLineTotalMergeBase: 'abc123' }),
      provider.getStatus('/home/user/repo', { branchLineTotalMergeBase: 'def456' })
    ]
    await waitForRequestCount(mux.request, 3)

    expect(mux.request.mock.calls.map(([, payload]) => payload)).toEqual([
      { worktreePath: '/home/user/repo' },
      { worktreePath: '/home/user/repo', branchLineTotalMergeBase: 'abc123' },
      { worktreePath: '/home/user/repo', branchLineTotalMergeBase: 'def456' }
    ])
    pendingRequests.forEach((pending) =>
      pending.resolve({ entries: [], conflictOperation: 'unknown' })
    )
    await Promise.all(reads)
  })

  it('keeps status leases isolated per provider and relay incarnation', async () => {
    const pendingRequests = Array.from({ length: 3 }, () =>
      deferredPromise<{ entries: never[]; conflictOperation: 'unknown' }>()
    )
    mux.request.mockImplementation(
      () => pendingRequests[mux.request.mock.calls.length - 1]?.promise
    )
    const replacement = new SshGitProvider('conn-1', mux as never)
    const otherConnection = new SshGitProvider('conn-2', mux as never)

    const reads = [
      provider.getStatus('/home/user/repo'),
      replacement.getStatus('/home/user/repo'),
      otherConnection.getStatus('/home/user/repo')
    ]
    await waitForRequestCount(mux.request, 3)

    expect(mux.request).toHaveBeenCalledTimes(3)
    pendingRequests.forEach((pending) =>
      pending.resolve({ entries: [], conflictOperation: 'unknown' })
    )
    await Promise.all(reads)
  })

  it('fences status reads before, during, and after an SSH mutation', async () => {
    const statusRequests = Array.from({ length: 3 }, () =>
      deferredPromise<{ entries: never[]; conflictOperation: 'unknown' }>()
    )
    const mutation = deferredPromise<void>()
    let statusRequestIndex = 0
    mux.request.mockImplementation((method) => {
      if (method === 'git.status') {
        return statusRequests[statusRequestIndex++]?.promise
      }
      if (method === 'git.stage') {
        return mutation.promise
      }
      return Promise.resolve(undefined)
    })

    const beforeMutation = provider.getStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 1)
    const mutating = provider.stageFile('/home/user/repo', 'src/file.ts')
    await waitForRequestCount(mux.request, 2)
    const duringMutation = provider.getStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 3)
    mutation.resolve(undefined)
    await mutating
    const afterMutation = provider.getStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 4)

    statusRequests.forEach((pending) =>
      pending.resolve({ entries: [], conflictOperation: 'unknown' })
    )
    await Promise.all([beforeMutation, duringMutation, afterMutation])
    expect(mux.request.mock.calls.filter(([method]) => method === 'git.status')).toHaveLength(3)
  })
})
