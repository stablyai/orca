import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  gitExecFileAsyncMock,
  getSshGitProviderMock,
  getSshGitProviderGenerationMock,
  readLocalGitConfigSignatureMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn(),
  getSshGitProviderGenerationMock: vi.fn(() => 0),
  readLocalGitConfigSignatureMock: vi.fn<() => Promise<string | undefined>>(async () => 'sig-1')
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock
}))
vi.mock('../github/local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-url-probe'
import {
  _resetRemoteNameListingCache,
  listCachedRemoteNames,
  shouldProbeGitRemote
} from './remote-name-listing'

function remoteListCalls(): unknown[][] {
  return gitExecFileAsyncMock.mock.calls.filter(
    ([args]) => Array.isArray(args) && args[0] === 'remote' && args[1] !== 'get-url'
  )
}

describe('cached git remote name listing', () => {
  beforeEach(() => {
    _resetRemoteNameListingCache()
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    getSshGitProviderGenerationMock.mockReset()
    getSshGitProviderGenerationMock.mockReturnValue(0)
    readLocalGitConfigSignatureMock.mockReset()
    readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-1')
  })

  it('skips probing upstream when listing only has origin', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'origin\n' })

    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
    await expect(listCachedRemoteNames('/repo')).resolves.toEqual(['origin'])
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS
    })
  })

  it('still probes upstream when listing includes that remote', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'origin\nupstream\n' })

    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(true)
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('reuses a signed listing instead of spawning git remote again', async () => {
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'origin\n' })

    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
    await expect(shouldProbeGitRemote('/repo', 'origin')).resolves.toBe(true)

    expect(remoteListCalls()).toHaveLength(1)
  })

  it('re-lists as soon as the git config signature changes', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'origin\n' })
      .mockResolvedValueOnce({ stdout: 'origin\nupstream\n' })

    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
    readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-2')
    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(true)
    expect(remoteListCalls()).toHaveLength(2)
  })

  it('expires an unsigned listing after the short TTL', async () => {
    vi.useFakeTimers()
    try {
      readLocalGitConfigSignatureMock.mockImplementation(async () => undefined)
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'origin\n' })
        .mockResolvedValueOnce({ stdout: 'origin\nupstream\n' })

      await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(30_001)
      await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(true)
      expect(remoteListCalls()).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('holds a signed listing past the unsigned TTL', async () => {
    vi.useFakeTimers()
    try {
      gitExecFileAsyncMock.mockResolvedValue({ stdout: 'origin\n' })

      await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
      await vi.advanceTimersByTimeAsync(4 * 60_000)
      await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
      expect(remoteListCalls()).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails open and does not cache when listing throws', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('git timed out.'))
      .mockResolvedValueOnce({ stdout: 'origin\n' })

    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(true)
    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
    expect(remoteListCalls()).toHaveLength(2)
  })

  it('coalesces concurrent listings onto one spawn', async () => {
    gitExecFileAsyncMock.mockImplementation(async () => {
      await Promise.resolve()
      return { stdout: 'origin\n' }
    })

    await expect(
      Promise.all([
        shouldProbeGitRemote('/repo', 'upstream'),
        shouldProbeGitRemote('/repo', 'upstream'),
        listCachedRemoteNames('/repo')
      ])
    ).resolves.toEqual([false, false, ['origin']])
    expect(remoteListCalls()).toHaveLength(1)
  })

  it('keeps host and WSL listings separate', async () => {
    gitExecFileAsyncMock.mockImplementation(
      async (_args: string[], options: { wslDistro?: string } = {}) => ({
        stdout: options.wslDistro ? 'origin\nupstream\n' : 'origin\n'
      })
    )

    await expect(shouldProbeGitRemote('/repo', 'upstream')).resolves.toBe(false)
    await expect(
      shouldProbeGitRemote('/repo', 'upstream', null, { wslDistro: 'Ubuntu' })
    ).resolves.toBe(true)
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['remote'], {
      cwd: '/repo',
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      wslDistro: 'Ubuntu'
    })
  })

  it('lists remotes through the SSH git provider', async () => {
    const exec = vi.fn(async () => ({ stdout: 'origin\n', stderr: '' }))
    getSshGitProviderMock.mockReturnValue({ exec })

    await expect(shouldProbeGitRemote('/remote/repo', 'upstream', 'ssh-1')).resolves.toBe(false)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(exec).toHaveBeenCalledWith(['remote'], '/remote/repo', {
      signal: expect.any(AbortSignal)
    })
  })

  it('fails open when the SSH git provider is missing instead of listing locally', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)

    await expect(shouldProbeGitRemote('/remote/repo', 'upstream', 'ssh-1')).resolves.toBe(true)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
