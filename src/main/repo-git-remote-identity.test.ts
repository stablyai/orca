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

    const identity = {
      canonicalKey: 'gitlab.example.com/team/orca',
      remoteName: 'origin',
      remoteUrl: 'git@gitlab.example.com:team/orca.git'
    }
    await expect(probeGitRemoteIdentity('/repos/orca')).resolves.toEqual({
      status: 'resolved',
      identity,
      remotes: [identity]
    })
  })

  it('returns every canonical remote of a fork checkout, primary first', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({
      stdout: [
        'origin\tgit@gitlab.example.com:ava/orca.git (fetch)',
        'origin\tgit@gitlab.example.com:ava/orca.git (push)',
        'upstream\tgit@gitlab.example.com:team/orca.git (fetch)',
        'mirror\tgit@gitlab.example.com:team/orca.git (fetch)',
        ''
      ].join('\n'),
      stderr: ''
    })

    const probe = await probeGitRemoteIdentity('/repos/orca')

    expect(probe.status).toBe('resolved')
    // `upstream` outranks `origin`, and the duplicate `mirror` URL is deduped away.
    expect(
      probe.status === 'resolved' && probe.remotes.map((remote) => remote.canonicalKey)
    ).toEqual(['gitlab.example.com/team/orca', 'gitlab.example.com/ava/orca'])
    expect(probe.status === 'resolved' && probe.identity.remoteName).toBe('upstream')
  })

  it('bounds the local probe when a timeout is requested', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: gitlabRemote, stderr: '' })

    await probeGitRemoteIdentity('/repos/orca', null, { timeoutMs: 3000 })

    expect(gitExecFileAsync).toHaveBeenCalledWith(['remote', '-v'], {
      cwd: '/repos/orca',
      timeout: 3000
    })
  })

  it('bounds the SSH probe and degrades a timeout to unavailable', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('command timed out'))
    vi.mocked(getSshGitProvider).mockReturnValue({ exec } as never)

    await expect(
      probeGitRemoteIdentity('/repos/orca', 'builder', { timeoutMs: 3000 })
    ).resolves.toEqual({ status: 'unavailable' })
    expect(exec).toHaveBeenCalledWith(['remote', '-v'], '/repos/orca', { timeoutMs: 3000 })
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
