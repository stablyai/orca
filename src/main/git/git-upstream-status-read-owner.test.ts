import { describe, expect, it, vi } from 'vitest'
import type { GitUpstreamStatus } from '../../shared/git-status-types'
import type { GitPushTarget } from '../../shared/worktree/types'
import {
  GitUpstreamStatusReadOwner,
  type GitUpstreamStatusExecutionIdentity
} from './git-upstream-status-read-owner'

const upstreamStatus: GitUpstreamStatus = {
  hasUpstream: true,
  upstreamName: 'origin/main',
  ahead: 1,
  behind: 0
}

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

describe('GitUpstreamStatusReadOwner', () => {
  it('shares one live read across ten identical callers', async () => {
    const owner = new GitUpstreamStatusReadOwner()
    const pending = deferredPromise<GitUpstreamStatus>()
    const load = vi.fn(() => pending.promise)

    const reads = Array.from({ length: 10 }, () =>
      owner.read({ kind: 'native' }, '/repo', undefined, load)
    )
    await Promise.resolve()

    expect(load).toHaveBeenCalledTimes(1)
    pending.resolve(upstreamStatus)
    await expect(Promise.all(reads)).resolves.toEqual(
      Array.from({ length: 10 }, () => upstreamStatus)
    )
  })

  it('isolates paths, execution hosts, and every explicit target field', async () => {
    const owner = new GitUpstreamStatusReadOwner()
    const load = vi.fn().mockResolvedValue(upstreamStatus)
    const baseTarget: GitPushTarget = {
      remoteName: 'fork',
      branchName: 'feature'
    }
    const cases: [GitUpstreamStatusExecutionIdentity, string, GitPushTarget | undefined][] = [
      [{ kind: 'native' }, '/repo-a', undefined],
      [{ kind: 'native' }, '/repo-b', undefined],
      [{ kind: 'wsl', distro: 'Ubuntu' }, '/repo-a', undefined],
      [{ kind: 'wsl', distro: 'Debian' }, '/repo-a', undefined],
      [{ kind: 'native' }, '/repo-a', baseTarget],
      [{ kind: 'native' }, '/repo-a', { ...baseTarget, remoteName: 'origin' }],
      [{ kind: 'native' }, '/repo-a', { ...baseTarget, branchName: 'other' }],
      [
        { kind: 'native' },
        '/repo-a',
        { ...baseTarget, remoteUrl: 'https://github.com/example/fork.git' }
      ],
      [{ kind: 'native' }, '/repo-a', { ...baseTarget, remoteCreated: false }],
      [{ kind: 'native' }, '/repo-a', { ...baseTarget, remoteCreated: true }],
      [{ kind: 'ssh-provider' }, '/repo-a', baseTarget]
    ]

    await Promise.all(
      cases.map(([identity, worktreePath, target]) =>
        owner.read(identity, worktreePath, target, load)
      )
    )

    expect(load).toHaveBeenCalledTimes(cases.length)
  })

  it('runs fresh work after success and rejection', async () => {
    const owner = new GitUpstreamStatusReadOwner()
    const failure = new Error('upstream failed')
    const load = vi
      .fn<() => Promise<GitUpstreamStatus>>()
      .mockResolvedValueOnce(upstreamStatus)
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(upstreamStatus)

    await expect(owner.read({ kind: 'native' }, '/repo', undefined, load)).resolves.toBe(
      upstreamStatus
    )
    await expect(owner.read({ kind: 'native' }, '/repo', undefined, load)).rejects.toBe(failure)
    await expect(owner.read({ kind: 'native' }, '/repo', undefined, load)).resolves.toBe(
      upstreamStatus
    )
    expect(load).toHaveBeenCalledTimes(3)
  })

  it('fences before, during, and after mutation generations', async () => {
    const owner = new GitUpstreamStatusReadOwner()
    const pendingReads = Array.from({ length: 3 }, () => deferredPromise<GitUpstreamStatus>())
    const load = vi.fn(() => pendingReads[load.mock.calls.length - 1].promise)

    const before = owner.read({ kind: 'native' }, '/repo', undefined, load)
    await Promise.resolve()
    owner.invalidate()
    const during = owner.read({ kind: 'native' }, '/repo', undefined, load)
    await Promise.resolve()
    owner.invalidate()
    const after = owner.read({ kind: 'native' }, '/repo', undefined, load)
    await Promise.resolve()

    pendingReads.forEach((pending) => pending.resolve(upstreamStatus))
    await expect(Promise.all([before, during, after])).resolves.toEqual(
      Array.from({ length: 3 }, () => upstreamStatus)
    )
    expect(load).toHaveBeenCalledTimes(3)
  })
})
