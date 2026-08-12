import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getSshGitProviderMock, gitExecFileAsyncMock } = vi.hoisted(() => ({
  getSshGitProviderMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'SSH Git provider unavailable'
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import {
  assertRemoteUrlReadable,
  isTransientGitProbeError,
  listRemoteNames,
  parseRemoteNames,
  readRemoteUrl,
  REMOTE_URL_PROBE_TIMEOUT_MS
} from './remote-url-probe'

describe('remote URL probe', () => {
  beforeEach(() => {
    getSshGitProviderMock.mockReset()
    gitExecFileAsyncMock.mockReset()
  })

  it('parses remote names from git remote stdout', () => {
    expect(parseRemoteNames('origin\nupstream\nmyremote\n')).toEqual([
      'origin',
      'upstream',
      'myremote'
    ])
    expect(parseRemoteNames('')).toEqual([])
  })

  it('lists remote names locally with the shared timeout', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'myremote\norigin\n', stderr: '' })

    await expect(listRemoteNames({ repoPath: '/repo' })).resolves.toEqual(['myremote', 'origin'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
  })

  it('lists remote names through WSL with the shared timeout', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'myremote\n', stderr: '' })

    await expect(listRemoteNames({ repoPath: '/home/repo', wslDistro: 'Ubuntu' })).resolves.toEqual(
      ['myremote']
    )
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote'], {
      cwd: '/home/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      wslDistro: 'Ubuntu'
    })
  })

  it('lists remote names through the SSH provider', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'myremote\n', stderr: '' })
    getSshGitProviderMock.mockReturnValue({ exec })

    await expect(listRemoteNames({ repoPath: '/repo', connectionId: 'conn-1' })).resolves.toEqual([
      'myremote'
    ])
    expect(exec).toHaveBeenCalledWith(['remote'], '/repo', {
      signal: expect.any(AbortSignal)
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns an empty list when the SSH provider is unavailable', async () => {
    getSshGitProviderMock.mockReturnValue(null)
    await expect(listRemoteNames({ repoPath: '/repo', connectionId: 'conn-1' })).resolves.toEqual(
      []
    )
  })

  it('bounds local and WSL remote reads with the shared timeout', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'git@github.com:acme/orca.git\n' })

    await expect(
      readRemoteUrl({ repoPath: '/repo', wslDistro: 'Ubuntu' }, 'upstream')
    ).resolves.toContain('github.com')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      wslDistro: 'Ubuntu'
    })

    await expect(readRemoteUrl({ repoPath: '/repo' }, 'origin')).resolves.toContain('github.com')

    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
    expect(REMOTE_URL_PROBE_TIMEOUT_MS).toBe(30_000)
  })

  it('bounds the SSH remote read with the same deadline as the local one', async () => {
    const exec = vi.fn(
      async (_args: string[], _cwd: string, _options?: { signal?: AbortSignal }) => ({
        stdout: 'git@github.com:acme/orca.git\n'
      })
    )
    getSshGitProviderMock.mockReturnValue({ exec })

    await expect(
      readRemoteUrl({ repoPath: '/repo', connectionId: 'ssh-1' }, 'origin')
    ).resolves.toContain('github.com')

    const [args, cwd, options] = exec.mock.calls[0]
    expect(args).toEqual(['remote', 'get-url', 'origin'])
    expect(cwd).toBe('/repo')
    // The relay bounds each phase separately and resets on every frame, so only a
    // signal spans the whole round trip.
    expect(options?.signal).toBeInstanceOf(AbortSignal)
    expect(options?.signal?.aborted).toBe(false)
  })

  it('reports a probe cut off by its deadline as unavailable, not as an answer', async () => {
    const aborted = new Error('Request was cancelled')
    aborted.name = 'AbortError'
    getSshGitProviderMock.mockReturnValue({
      exec: vi.fn(async () => {
        throw aborted
      })
    })

    expect(isTransientGitProbeError(aborted)).toBe(true)
    await expect(
      assertRemoteUrlReadable({ repoPath: '/repo', connectionId: 'ssh-1' })
    ).rejects.toBe(aborted)
  })

  it('rethrows a timed-out local probe so callers can report unavailable', async () => {
    const timeout = new Error('git timed out.')
    gitExecFileAsyncMock.mockRejectedValue(timeout)

    expect(isTransientGitProbeError(timeout)).toBe(true)
    await expect(assertRemoteUrlReadable({ repoPath: '/repo' })).rejects.toBe(timeout)
  })

  it('accepts a stable missing remote as a readable, empty repository state', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error("fatal: No such remote 'origin'"))

    await expect(assertRemoteUrlReadable({ repoPath: '/repo' })).resolves.toBeUndefined()
  })

  it('does not turn a missing SSH provider into a false readable result', async () => {
    getSshGitProviderMock.mockReturnValue(null)

    await expect(
      assertRemoteUrlReadable({ repoPath: '/repo', connectionId: 'ssh-1' })
    ).rejects.toThrow('SSH Git provider unavailable')
  })
})
