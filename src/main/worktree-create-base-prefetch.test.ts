import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getBaseRefDefault: vi.fn(),
  gitExecFileAsync: vi.fn(),
  getSshGitProvider: vi.fn(),
  prefetchRemoteWorktreeCreateBase: vi.fn(),
  resolveRemoteTrackingBase: vi.fn(),
  hasRemoteTrackingRef: vi.fn(),
  getOrStartRemoteTrackingBaseRefresh: vi.fn(),
  fetchRemoteWithCache: vi.fn()
}))

vi.mock('./git/repo', () => ({ getBaseRefDefault: mocks.getBaseRefDefault }))
vi.mock('./git/runner', () => ({ gitExecFileAsync: mocks.gitExecFileAsync }))
vi.mock('./providers/ssh-git-dispatch', () => ({ getSshGitProvider: mocks.getSshGitProvider }))
vi.mock('./ipc/worktree-remote', () => ({
  prefetchRemoteWorktreeCreateBase: mocks.prefetchRemoteWorktreeCreateBase
}))

import { prefetchWorktreeCreateBase } from './worktree-create-base-prefetch'

const repo = {
  id: 'repo-1',
  path: String.raw`C:\workspace\repo`,
  displayName: 'repo',
  badgeColor: '#000000',
  addedAt: 0
}

const WSL = { wslDistro: 'Ubuntu' }

function runtime() {
  return {
    resolveRemoteTrackingBase: mocks.resolveRemoteTrackingBase,
    hasRemoteTrackingRef: mocks.hasRemoteTrackingRef,
    getOrStartRemoteTrackingBaseRefresh: mocks.getOrStartRemoteTrackingBaseRefresh,
    fetchRemoteWithCache: mocks.fetchRemoteWithCache
  }
}

/** Resolve only the named refs/objects; every other rev-parse answers "absent". */
function resolveOnly(present: string[]): void {
  mocks.gitExecFileAsync.mockImplementation(async (args: string[]) => {
    const rev = args.at(-1)?.replace('^{commit}', '') ?? ''
    return present.includes(rev)
      ? { stdout: `${'f'.repeat(40)}\n`, stderr: '' }
      : { stdout: '', stderr: '' }
  })
}

function revParse(ref: string): string[] {
  return ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset()
  }
  mocks.getBaseRefDefault.mockResolvedValue('origin/main')
  resolveOnly([])
  mocks.resolveRemoteTrackingBase.mockResolvedValue(null)
  mocks.hasRemoteTrackingRef.mockResolvedValue(false)
  mocks.getOrStartRemoteTrackingBaseRefresh.mockResolvedValue({ ok: true })
  mocks.fetchRemoteWithCache.mockResolvedValue(undefined)
})

describe('prefetchWorktreeCreateBase local git routing', () => {
  it('resolves the default base and its ref probes inside the selected WSL distro', async () => {
    resolveOnly(['refs/remotes/origin/main'])

    await expect(
      prefetchWorktreeCreateBase({ repo, runtime: runtime(), gitOptions: WSL })
    ).resolves.toBe('origin/main')

    expect(mocks.getBaseRefDefault).toHaveBeenCalledWith(repo.path, WSL)
    expect(mocks.resolveRemoteTrackingBase).toHaveBeenCalledWith(repo.path, 'origin/main', WSL)
    expect(mocks.gitExecFileAsync).toHaveBeenCalledWith(revParse('refs/remotes/origin/main'), {
      cwd: repo.path,
      ...WSL
    })
    // A base that is already local needs no fetch.
    expect(mocks.fetchRemoteWithCache).not.toHaveBeenCalled()
  })

  it('probes a full commit object inside the selected WSL distro', async () => {
    const sha = 'a'.repeat(40)
    resolveOnly([sha])

    await expect(
      prefetchWorktreeCreateBase({ repo, baseBranch: sha, runtime: runtime(), gitOptions: WSL })
    ).resolves.toBe(sha)

    expect(mocks.gitExecFileAsync).toHaveBeenCalledWith(revParse(sha), {
      cwd: repo.path,
      ...WSL
    })
    expect(mocks.fetchRemoteWithCache).not.toHaveBeenCalled()
  })

  it('routes the exact remote-base refresh through the selected WSL distro', async () => {
    const remoteTrackingBase = {
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    }
    mocks.resolveRemoteTrackingBase.mockResolvedValue(remoteTrackingBase)
    mocks.hasRemoteTrackingRef.mockResolvedValue(true)

    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions: WSL
      })
    ).resolves.toBe('origin/main')

    expect(mocks.hasRemoteTrackingRef).toHaveBeenCalledWith(repo.path, remoteTrackingBase, WSL)
    expect(mocks.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledWith(
      repo.path,
      remoteTrackingBase,
      WSL
    )
  })

  it('routes the broad remote-fetch fallback through the selected WSL distro', async () => {
    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'feature/topic',
        runtime: runtime(),
        gitOptions: WSL
      })
    ).resolves.toBe('feature/topic')

    expect(mocks.fetchRemoteWithCache).toHaveBeenCalledWith(repo.path, 'origin', WSL)
  })

  it('leaves host-routed probes on the git host they used before routing existed', async () => {
    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'feature/topic',
        runtime: runtime(),
        gitOptions: {}
      })
    ).resolves.toBe('feature/topic')

    expect(mocks.gitExecFileAsync).toHaveBeenCalledWith(revParse('refs/remotes/feature/topic'), {
      cwd: repo.path
    })
    for (const call of mocks.gitExecFileAsync.mock.calls) {
      expect(call[1]).toEqual({ cwd: repo.path })
    }
    // Runtime calls keep their original arity so host repos stay on the runtime's own defaults.
    expect(mocks.resolveRemoteTrackingBase).toHaveBeenCalledWith(repo.path, 'feature/topic')
    expect(mocks.fetchRemoteWithCache).toHaveBeenCalledWith(repo.path, 'origin')
  })

  it('does not resolve a local base for SSH repos', async () => {
    const prepareCheckout = vi.fn()
    const provider = { exec: vi.fn() }
    mocks.getSshGitProvider.mockReturnValue(provider)

    await expect(
      prefetchWorktreeCreateBase({
        repo: { ...repo, connectionId: 'conn-1' },
        prepareCheckout,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions: WSL
      })
    ).resolves.toBeUndefined()

    expect(mocks.prefetchRemoteWorktreeCreateBase).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ connectionId: 'conn-1' }),
      { baseBranch: 'origin/main' }
    )
    expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
    expect(prepareCheckout).not.toHaveBeenCalled()
  })
})

describe('checkout and refresh overlap', () => {
  it.each([{}, WSL])(
    'starts one checkout before a blocked refresh finishes on %j',
    async (gitOptions) => {
      const base = {
        remote: 'origin',
        branch: 'main',
        ref: 'refs/remotes/origin/main',
        base: 'origin/main'
      }
      mocks.resolveRemoteTrackingBase.mockResolvedValue(base)
      mocks.hasRemoteTrackingRef.mockResolvedValue(true)
      let release!: () => void
      mocks.getOrStartRemoteTrackingBaseRefresh.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
      )
      const prepareCheckout = vi.fn().mockResolvedValue(undefined)
      let settled = false
      const result = prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions,
        prepareCheckout
      }).finally(() => {
        settled = true
      })
      await vi.waitFor(() => expect(prepareCheckout).toHaveBeenCalledWith('origin/main'))
      expect(settled).toBe(false)
      release()
      await expect(result).resolves.toBe('origin/main')
      expect(prepareCheckout).toHaveBeenCalledTimes(1)
    }
  )

  it('waits for refresh when the selected base is not local', async () => {
    mocks.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    let release!: () => void
    mocks.getOrStartRemoteTrackingBaseRefresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    const prepareCheckout = vi.fn().mockResolvedValue(undefined)
    const result = prefetchWorktreeCreateBase({
      repo,
      baseBranch: 'origin/main',
      runtime: runtime(),
      gitOptions: {},
      prepareCheckout
    })
    await vi.waitFor(() =>
      expect(mocks.getOrStartRemoteTrackingBaseRefresh).toHaveBeenCalledTimes(1)
    )
    expect(prepareCheckout).not.toHaveBeenCalled()
    release()
    await result
    expect(prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('does not fail a successful refresh because preparation fails', async () => {
    mocks.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    mocks.hasRemoteTrackingRef.mockResolvedValue(true)
    const prepareCheckout = vi.fn().mockRejectedValue(new Error('checkout failed'))
    await expect(
      prefetchWorktreeCreateBase({
        repo,
        baseBranch: 'origin/main',
        runtime: runtime(),
        gitOptions: {},
        prepareCheckout
      })
    ).resolves.toBe('origin/main')
    expect(prepareCheckout).toHaveBeenCalledTimes(1)
  })

  it('settles preparation before propagating refresh failure', async () => {
    mocks.resolveRemoteTrackingBase.mockResolvedValue({
      remote: 'origin',
      branch: 'main',
      ref: 'refs/remotes/origin/main',
      base: 'origin/main'
    })
    mocks.hasRemoteTrackingRef.mockResolvedValue(true)
    const error = new Error('refresh failed')
    mocks.getOrStartRemoteTrackingBaseRefresh.mockRejectedValue(error)
    let release!: () => void
    const prepareCheckout = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    let settled = false
    const result = prefetchWorktreeCreateBase({
      repo,
      baseBranch: 'origin/main',
      runtime: runtime(),
      gitOptions: {},
      prepareCheckout
    }).finally(() => {
      settled = true
    })
    const assertion = expect(result).rejects.toBe(error)
    await vi.waitFor(() => expect(prepareCheckout).toHaveBeenCalledTimes(1))
    expect(settled).toBe(false)
    release()
    await assertion
  })
})

it('does not prepare folder repositories', async () => {
  const prepareCheckout = vi.fn()
  await expect(
    prefetchWorktreeCreateBase({
      repo: { ...repo, kind: 'folder' },
      runtime: runtime(),
      gitOptions: {},
      prepareCheckout
    })
  ).resolves.toBeUndefined()
  expect(prepareCheckout).not.toHaveBeenCalled()
  expect(mocks.gitExecFileAsync).not.toHaveBeenCalled()
})
