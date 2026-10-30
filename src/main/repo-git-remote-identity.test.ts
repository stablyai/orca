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

  it('settles on no-remote when git answers with nothing usable', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: '', stderr: '' })

    await expect(probeGitRemoteIdentity('/repos/orca', 'local')).resolves.toEqual({
      status: 'no-remote'
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

  it('reports unavailable when the local git command fails', async () => {
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('not a git repository'))

    await expect(probeGitRemoteIdentity('/repos/orca', 'local')).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('bounds the local probe with a deadline and forwards the caller signal', async () => {
    vi.mocked(gitExecFileAsync).mockResolvedValue({ stdout: gitlabRemote, stderr: '' })
    const controller = new AbortController()

    await probeGitRemoteIdentity('/repos/orca', 'local', { signal: controller.signal })

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

  it('maps a timed-out local probe to unavailable, never no-remote', async () => {
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('git timed out.'))

    await expect(probeGitRemoteIdentity('/repos/orca', 'local')).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('maps an aborted probe to unavailable, never no-remote', async () => {
    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    vi.mocked(gitExecFileAsync).mockRejectedValue(abortError)
    const controller = new AbortController()
    controller.abort()

    await expect(
      probeGitRemoteIdentity('/repos/orca', 'local', { signal: controller.signal })
    ).resolves.toEqual({ status: 'unavailable' })
  })
})
