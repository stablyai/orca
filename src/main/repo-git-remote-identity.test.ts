import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { gitExecFileAsync } from './git/runner'
import { registerSshGitProvider, unregisterSshGitProvider } from './providers/ssh-git-dispatch'
import { probeGitRemoteIdentity } from './repo-git-remote-identity'

vi.mock('./git/runner', () => ({ gitExecFileAsync: vi.fn() }))

const gitlabRemote = 'origin\tgit@gitlab.example.com:team/orca.git (fetch)\n'
const gitlabIdentity = {
  canonicalKey: 'gitlab.example.com/team/orca',
  remoteName: 'origin',
  remoteUrl: 'git@gitlab.example.com:team/orca.git'
}

const registered: string[] = []

function registerHost(connectionId: string, stdout = gitlabRemote) {
  const exec = vi.fn().mockResolvedValue({ stdout, stderr: '' })
  registerSshGitProvider(connectionId, { exec } as never)
  registered.push(connectionId)
  return exec
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  for (const connectionId of registered.splice(0)) {
    unregisterSshGitProvider(connectionId)
  }
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

  it('routes each SSH host to its own git provider', async () => {
    const m4air = registerHost('m4air')
    const openclaw = registerHost(
      'openclaw',
      'origin\tgit@gitlab.example.com:team/other.git (fetch)\n'
    )

    await expect(probeGitRemoteIdentity('/repos/orca', 'ssh:m4air')).resolves.toEqual({
      status: 'resolved',
      identity: gitlabIdentity
    })
    await expect(probeGitRemoteIdentity('/repos/orca', 'ssh:openclaw')).resolves.toEqual({
      status: 'resolved',
      identity: {
        canonicalKey: 'gitlab.example.com/team/other',
        remoteName: 'origin',
        remoteUrl: 'git@gitlab.example.com:team/other.git'
      }
    })
    expect(m4air).toHaveBeenCalledTimes(1)
    expect(openclaw).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  it('reports unavailable when the SSH host has no connected git provider', async () => {
    await expect(probeGitRemoteIdentity('/repos/orca', 'ssh:builder')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  // A runtime host's Git is executed by that environment's own server, and the SSH target on its
  // repo row lives in that server's namespace. Dialing a same-named target here answers for
  // another machine's repository.
  it('refuses a runtime host even when its nested SSH target is registered on this client', async () => {
    const nested = registerHost('nested-1')

    await expect(probeGitRemoteIdentity('/repos/orca', 'runtime:env-a')).resolves.toEqual({
      status: 'unavailable'
    })
    expect(nested).not.toHaveBeenCalled()
    expect(gitExecFileAsync).not.toHaveBeenCalled()
  })

  it('reports unavailable when the local git command fails', async () => {
    vi.mocked(gitExecFileAsync).mockRejectedValue(new Error('not a git repository'))

    await expect(probeGitRemoteIdentity('/repos/orca', 'local')).resolves.toEqual({
      status: 'unavailable'
    })
  })

  it('reports unavailable when a connected SSH provider cannot reach the host', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('ssh: connect to host builder: down'))
    registerSshGitProvider('builder', { exec } as never)
    registered.push('builder')

    await expect(probeGitRemoteIdentity('/repos/orca', 'ssh:builder')).resolves.toEqual({
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
    registerHost('builder', '')

    await expect(probeGitRemoteIdentity('/repos/orca', 'ssh:builder')).resolves.toEqual({
      status: 'no-remote'
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

  it('bounds the SSH probe under the relay request timeout and forwards the caller signal', async () => {
    const exec = registerHost('builder')
    const controller = new AbortController()

    await probeGitRemoteIdentity('/repos/orca', 'ssh:builder', { signal: controller.signal })

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
