import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({ gitExecFileAsync: gitExecFileAsyncMock }))

import { SshHostNotServedError } from '../providers/ssh-host-not-served-error'
import {
  assertRemoteUrlReadable,
  isTransientGitProbeError,
  readRemoteUrl,
  REMOTE_URL_PROBE_TIMEOUT_MS
} from './remote-url-probe'

describe('remote URL probe', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
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
  })

  it('reports a probe cut off by its deadline as unavailable, not as an answer', async () => {
    const aborted = new Error('Request was cancelled')
    aborted.name = 'AbortError'
    gitExecFileAsyncMock.mockRejectedValue(aborted)

    expect(isTransientGitProbeError(aborted)).toBe(true)
    await expect(assertRemoteUrlReadable({ repoPath: '/repo' })).rejects.toBe(aborted)
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

  it('does not turn an SSH target into a false readable result', async () => {
    await expect(
      assertRemoteUrlReadable({ repoPath: '/repo', connectionId: 'ssh-1' })
    ).rejects.toThrow(SshHostNotServedError)
  })
})
