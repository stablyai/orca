import { beforeEach, describe, expect, it, vi } from 'vitest'

const gitExecFileAsyncMock = vi.hoisted(() => vi.fn())
const sshExecMock = vi.hoisted(() => vi.fn())
const getSshGitProviderMock = vi.hoisted(() => vi.fn())

vi.mock('./git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

import { detectGitRemoteIdentity } from './repo-git-remote-identity'

const remoteOutput = 'origin\tgit@git.company.test:team/repo.git (fetch)\n'

describe('detectGitRemoteIdentity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: remoteOutput, stderr: '' })
    sshExecMock.mockResolvedValue({ stdout: remoteOutput, stderr: '' })
    getSshGitProviderMock.mockReturnValue({ exec: sshExecMock })
  })

  it('bounds local git remote inspection', async () => {
    await expect(detectGitRemoteIdentity('/workspace/repo')).resolves.toMatchObject({
      canonicalKey: 'git.company.test/team/repo'
    })

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', '-v'], {
      cwd: '/workspace/repo',
      timeout: 5000
    })
  })

  it('bounds SSH git remote inspection on the selected provider', async () => {
    await expect(detectGitRemoteIdentity('/remote/repo', 'ssh-target')).resolves.toMatchObject({
      canonicalKey: 'git.company.test/team/repo'
    })

    expect(getSshGitProviderMock).toHaveBeenCalledWith('ssh-target')
    expect(sshExecMock).toHaveBeenCalledWith(['remote', '-v'], '/remote/repo', {
      timeoutMs: 5000
    })
  })

  it('returns null when the SSH provider is unavailable', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)

    await expect(detectGitRemoteIdentity('/remote/repo', 'missing')).resolves.toBeNull()
  })
})
