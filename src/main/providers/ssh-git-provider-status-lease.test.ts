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
