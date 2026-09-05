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
    const provider = { exec: vi.fn() }
    mocks.getSshGitProvider.mockReturnValue(provider)

    await expect(
      prefetchWorktreeCreateBase({
        repo: { ...repo, connectionId: 'conn-1' },
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
  })
})
