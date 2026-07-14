import { beforeEach, describe, expect, it, vi } from 'vitest'

const { ghExecFileAsyncMock, gitExecFileAsyncMock } = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn()
}))

// Mock only the exec boundary so the real remote-identity parsing, runtime
// option resolution, and `gh auth status` parsing run against controlled output.
vi.mock('../git/runner', () => ({
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock
}))

import {
  _resetGitHubHostAuthCache,
  getEnterpriseGitHubRepoSlug,
  isGitHubHostAuthenticated
} from './github-enterprise-repository'

function mockOriginRemote(url: string): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: `${url}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

// gh exit 0 for `auth status --hostname <host>` means logged in to that host.
function mockHostAuthenticated(host = 'github.acme-corp.com'): void {
  ghExecFileAsyncMock.mockResolvedValue({
    stdout: `${host}\n  ✓ Logged in to ${host} account kelora (keyring)`,
    stderr: ''
  })
}

// gh exits non-zero and reports no matching host when not logged in.
function mockHostNotAuthenticated(): void {
  ghExecFileAsyncMock.mockRejectedValue(
    Object.assign(new Error('exit 1'), {
      stdout: '',
      stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login'
    })
  )
}

describe('getEnterpriseGitHubRepoSlug', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    _resetGitHubHostAuthCache()
  })

  it('resolves a GHES remote whose host the user is gh-authenticated to (#8312)', async () => {
    mockOriginRemote('https://github.acme-corp.com/team/orca.git')
    mockHostAuthenticated()

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
    // The auth probe targets the remote's host, not a hardcoded github.com.
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'github.acme-corp.com'],
      { cwd: '/repo' }
    )
  })

  it('resolves a GHES SCP-style SSH remote', async () => {
    mockOriginRemote('git@github.acme-corp.com:team/orca.git')
    mockHostAuthenticated()

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    })
  })

  it('probes gh in the repository WSL runtime, not the host/default distro', async () => {
    mockOriginRemote('https://github.acme-corp.com/team/orca.git')
    mockHostAuthenticated()

    await getEnterpriseGitHubRepoSlug('/repo', null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'github.acme-corp.com'],
      { cwd: '/repo', wslDistro: 'Ubuntu' }
    )
  })

  it('leaves github.com to getOwnerRepo without probing gh auth', async () => {
    mockOriginRemote('https://github.com/team/orca.git')

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeNull()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('declines a custom host the user is not gh-authenticated to (leaves it for Gitea)', async () => {
    mockOriginRemote('https://gitea.example.com/team/orca.git')
    mockHostNotAuthenticated()

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeNull()
  })

  it('returns null for an unparseable remote', async () => {
    mockOriginRemote('not-a-remote-url')
    mockHostAuthenticated()

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeNull()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null when the origin remote lookup fails', async () => {
    gitExecFileAsyncMock.mockRejectedValue(new Error('no such remote'))

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeNull()
  })
})

describe('isGitHubHostAuthenticated', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    _resetGitHubHostAuthCache()
  })

  it('runs gh in the SSH-local runtime (no cwd) for connection-backed repos', async () => {
    mockHostAuthenticated()

    await expect(
      isGitHubHostAuthenticated('github.acme-corp.com', '/remote/repo', 'ssh-1')
    ).resolves.toBe(true)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['auth', 'status', '--hostname', 'github.acme-corp.com'],
      {}
    )
  })

  it('caches per runtime+host so detection polling does not re-spawn gh', async () => {
    mockHostAuthenticated()

    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo')
    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not share cache state across WSL distros', async () => {
    mockHostAuthenticated()

    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo', null, { wslDistro: 'Ubuntu' })
    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo', null, { wslDistro: 'Debian' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('treats a listed host as authenticated even when gh exits non-zero', async () => {
    ghExecFileAsyncMock.mockRejectedValue(
      Object.assign(new Error('exit 1'), {
        stdout: '',
        stderr:
          'github.acme-corp.com\n  ✓ Logged in to github.acme-corp.com account kelora (keyring)\n  X github.com: token expired'
      })
    )

    await expect(isGitHubHostAuthenticated('github.acme-corp.com', '/repo')).resolves.toBe(true)
  })

  it('does not cache a hard gh failure so a later probe can recover', async () => {
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('not installed'), { stdout: '', stderr: '' })
    )
    expect(await isGitHubHostAuthenticated('github.acme-corp.com', '/repo')).toBe(false)

    mockHostAuthenticated()
    expect(await isGitHubHostAuthenticated('github.acme-corp.com', '/repo')).toBe(true)
  })
})
