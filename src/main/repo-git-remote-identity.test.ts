import { beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { getSshGitProvider } from './providers/ssh-git-dispatch'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

vi.mock('./git/runner', () => ({ gitExecFileAsync: vi.fn() }))
vi.mock('./providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))

const gitlabRemote = 'origin\tgit@gitlab.example.com:team/orca.git (fetch)\n'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('probeGitRemoteIdentity', () => {
  it('resolves the canonical identity for a non-GitHub remote', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: gitlabRemote, stderr: '' })

    await expect(probeGitRemoteIdentity('/repos/orca')).resolves.toEqual({
      status: 'resolved',
      identity: {
        canonicalKey: 'gitlab.example.com/team/orca',
        remoteName: 'origin',
        remoteUrl: 'git@gitlab.example.com:team/orca.git'
      }
    })
  })

  it('settles on no-remote when git answers with nothing usable', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: '', stderr: '' })

    await expect(probeGitRemoteIdentity('/repos/orca')).resolves.toEqual({ status: 'no-remote' })
  })

  it('reports unavailable when the SSH host has no connected git provider', async () => {
    vi.mocked(getSshGitProvider).mockReturnValue(undefined)

    await expect(probeGitRemoteIdentity('/repos/orca', 'builder')).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('reports unavailable when the local git command fails', async () => {
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('not a git repository'))

    await expect(probeGitRemoteIdentity('/repos/orca')).resolves.toEqual({ status: 'unavailable' })
  })

  it('reports unavailable when a connected SSH provider cannot reach the host', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ssh: connect to host builder: down'))
    vi.mocked(getSshGitProvider).mockReturnValue({ exec } as never)

    await expect(probeGitRemoteIdentity('/repos/orca', 'builder')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(exec).toHaveBeenCalledWith(['remote', '-v'], '/repos/orca')
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  it('settles on no-remote for an SSH repo git answered for with no remotes', async () => {
    vi.mocked(getSshGitProvider).mockReturnValue({
      exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' })
    } as never)

    await expect(probeGitRemoteIdentity('/repos/orca', 'builder')).resolves.toEqual({
      status: 'no-remote'
    })
  })
})
