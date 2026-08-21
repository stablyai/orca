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
    expect(exec).toHaveBeenCalledWith(
      ['remote', '-v'],
      '/repos/orca',
      expect.objectContaining({ timeoutMs: expect.any(Number) })
    )
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

  it('bounds the local probe with a deadline and forwards the caller signal', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: gitlabRemote, stderr: '' })
    const controller = new AbortController()

    await probeGitRemoteIdentity('/repos/orca', null, { signal: controller.signal })

    expect(gitExecFileAsync).toHaveBeenCalledWith(
      ['remote', '-v'],
      expect.objectContaining({
        cwd: '/repos/orca',
        timeout: expect.any(Number),
        signal: controller.signal
      })
    )
    const [, options] = vi.mocked(gitExecFileAsync).mock.calls[0]
    expect(options.timeout).toBeGreaterThan(0)
  })

  it('bounds the SSH probe under the relay request timeout and forwards the caller signal', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: gitlabRemote, stderr: '' })
    vi.mocked(getSshGitProvider).mockReturnValue({ exec } as never)
    const controller = new AbortController()

    await probeGitRemoteIdentity('/repos/orca', 'builder', { signal: controller.signal })

    expect(exec).toHaveBeenCalledWith(
      ['remote', '-v'],
      '/repos/orca',
      expect.objectContaining({ timeoutMs: expect.any(Number), signal: controller.signal })
    )
    const relayRequestTimeoutMs = 30_000
    expect(exec.mock.calls[0][2].timeoutMs).toBeLessThan(relayRequestTimeoutMs)
  })

  it('maps a timed-out local probe to unavailable, never no-remote', async () => {
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('git timed out.'))

    await expect(probeGitRemoteIdentity('/repos/orca')).resolves.toEqual({ status: 'unavailable' })
  })

  it('maps an aborted probe to unavailable, never no-remote', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    vi.mocked(gitExecFileAsync).mockRejectedValue(abortError)
    const controller = new AbortController()
    controller.abort()

    await expect(
      probeGitRemoteIdentity('/repos/orca', null, { signal: controller.signal })
    ).resolves.toEqual({ status: 'unavailable' })
  })
})
