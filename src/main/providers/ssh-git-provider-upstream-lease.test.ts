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

describe('SshGitProvider upstream status read leases', () => {
  let mux: MockMultiplexer
  let provider: SshGitProvider

  beforeEach(() => {
    mux = createMockMux()
    provider = new SshGitProvider('conn-1', mux as never)
  })

  it('shares one upstream-status RPC across ten identical callers', async () => {
    const pending = deferredPromise<{
      hasUpstream: true
      upstreamName: string
      ahead: number
      behind: number
    }>()
    mux.request.mockReturnValue(pending.promise)

    const reads = Array.from({ length: 10 }, () => provider.getUpstreamStatus('/home/user/repo'))
    await waitForRequestCount(mux.request, 1)

    expect(mux.request).toHaveBeenCalledTimes(1)
    pending.resolve({ hasUpstream: true, upstreamName: 'origin/main', ahead: 1, behind: 0 })
    await expect(Promise.all(reads)).resolves.toHaveLength(10)
  })

  it('isolates upstream-status RPCs by worktree and every target field', async () => {
    mux.request.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'fork/feature',
      ahead: 0,
      behind: 0
    })
    const baseTarget = { remoteName: 'fork', branchName: 'feature' }

    await Promise.all([
      provider.getUpstreamStatus('/repo-a'),
      provider.getUpstreamStatus('/repo-b'),
      provider.getUpstreamStatus('/repo-a', baseTarget),
      provider.getUpstreamStatus('/repo-a', { ...baseTarget, remoteName: 'origin' }),
      provider.getUpstreamStatus('/repo-a', { ...baseTarget, branchName: 'other' }),
      provider.getUpstreamStatus('/repo-a', {
        ...baseTarget,
        remoteUrl: 'https://github.com/example/fork.git'
      }),
      provider.getUpstreamStatus('/repo-a', { ...baseTarget, remoteCreated: false }),
      provider.getUpstreamStatus('/repo-a', { ...baseTarget, remoteCreated: true })
    ])

    expect(mux.request).toHaveBeenCalledTimes(8)
  })

  it('keeps upstream-status reads isolated per provider instance', async () => {
    const otherProvider = new SshGitProvider('conn-1', mux as never)
    mux.request.mockResolvedValue({
      hasUpstream: true,
      upstreamName: 'origin/main',
      ahead: 0,
      behind: 0
    })

    await Promise.all([
      provider.getUpstreamStatus('/home/user/repo'),
      otherProvider.getUpstreamStatus('/home/user/repo')
    ])

    expect(mux.request).toHaveBeenCalledTimes(2)
  })

  it('runs a fresh upstream-status RPC after result and error settlement', async () => {
    const failure = new Error('upstream RPC failed')
    mux.request
      .mockResolvedValueOnce({
        hasUpstream: true,
        upstreamName: 'origin/main',
        ahead: 0,
        behind: 0
      })
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        hasUpstream: false,
        ahead: 0,
        behind: 0
      })

    await expect(provider.getUpstreamStatus('/home/user/repo')).resolves.toMatchObject({
      hasUpstream: true
    })
    await expect(provider.getUpstreamStatus('/home/user/repo')).rejects.toBe(failure)
    await expect(provider.getUpstreamStatus('/home/user/repo')).resolves.toMatchObject({
      hasUpstream: false
    })
    expect(mux.request).toHaveBeenCalledTimes(3)
  })

  it('fences upstream-status reads before, during, and after an SSH mutation', async () => {
    const upstreamRequests = Array.from({ length: 3 }, () =>
      deferredPromise<{ hasUpstream: false; ahead: 0; behind: 0 }>()
    )
    const mutation = deferredPromise<void>()
    let upstreamRequestIndex = 0
    mux.request.mockImplementation((method) => {
      if (method === 'git.upstreamStatus') {
        return upstreamRequests[upstreamRequestIndex++]?.promise
      }
      if (method === 'git.stage') {
        return mutation.promise
      }
      return Promise.resolve(undefined)
    })

    const beforeMutation = provider.getUpstreamStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 1)
    const mutating = provider.stageFile('/home/user/repo', 'src/file.ts')
    await waitForRequestCount(mux.request, 2)
    const duringMutation = provider.getUpstreamStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 3)
    mutation.resolve(undefined)
    await mutating
    const afterMutation = provider.getUpstreamStatus('/home/user/repo')
    await waitForRequestCount(mux.request, 4)

    upstreamRequests.forEach((pending) =>
      pending.resolve({ hasUpstream: false, ahead: 0, behind: 0 })
    )
    await Promise.all([beforeMutation, duringMutation, afterMutation])
    expect(
      mux.request.mock.calls.filter(([method]) => method === 'git.upstreamStatus')
    ).toHaveLength(3)
  })
})
