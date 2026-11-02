import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, readLocalGitConfigSignatureMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn<() => Promise<string | undefined>>(async () => 'sig-1')
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))
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
    readLocalGitConfigSignatureMock.mockReset()
    readLocalGitConfigSignatureMock.mockImplementation(async () => 'sig-1')
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

  it('uses the short TTL when config changes during remote listing', async () => {
    vi.useFakeTimers()
    try {
      readLocalGitConfigSignatureMock
        .mockResolvedValueOnce('sig-1')
        .mockResolvedValueOnce('sig-2')
        .mockResolvedValue('sig-2')
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

  it('fails open for an SSH repo instead of listing locally', async () => {
    await expect(shouldProbeGitRemote('/remote/repo', 'upstream', 'ssh-1')).resolves.toBe(true)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })
})
