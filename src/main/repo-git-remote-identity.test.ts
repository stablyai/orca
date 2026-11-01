import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

vi.mock('./git/runner', () => ({ gitExecFileAsync: vi.fn() }))

const gitlabRemote = 'origin\tgit@gitlab.example.com:team/orca.git (fetch)\n'
const gitlabIdentity = {
  canonicalKey: 'gitlab.example.com/team/orca',
  remoteName: 'origin',
  remoteUrl: 'git@gitlab.example.com:team/orca.git'
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('probeGitRemoteIdentity', () => {
  it('resolves the canonical identity for a non-GitHub remote', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: gitlabRemote, stderr: '' })

    await expect(probeGitRemoteIdentity('/repos/orca', 'local')).resolves.toEqual({
      status: 'resolved',
      identity: gitlabIdentity
    })
  })

  it('reports unavailable for an SSH host', async () => {
    await expect(probeGitRemoteIdentity('/repos/orca', 'ssh:builder')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  it('refuses a runtime host', async () => {
    await expect(probeGitRemoteIdentity('/repos/orca', 'runtime:env-a')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })
})
