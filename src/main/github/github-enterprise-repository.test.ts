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
  isGitHubHostAuthenticated,
  isGitHubHostAuthenticatedForGlobalCli
} from './github-enterprise-repository'

function mockOriginRemote(url: string): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: `${url}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

// gh auth status inventory entries represent hosts with configured credentials.
function mockHostAuthenticated(host = 'github.acme-corp.com'): void {
  mockAuthenticatedHosts([host])
}

function mockAuthenticatedHosts(hosts: string[]): void {
  ghExecFileAsyncMock.mockResolvedValue({
    stdout: hosts
      .map((host) => `${host}\n  ✓ Logged in to ${host} account kelora (keyring)`)
      .join('\n'),
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
    // Why: inventory configured gh hosts without targeting the untrusted remote;
    // passing it as --hostname could expose an ambient enterprise token.
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], { cwd: '/repo' })
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

  it('uses the unique ported auth host for a hostname-only SSH remote', async () => {
    mockOriginRemote('git@ghe.acme.com:team/orca.git')
    mockHostAuthenticated('ghe.acme.com:8443')

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
      owner: 'team',
      repo: 'orca',
      host: 'ghe.acme.com:8443'
    })
  })

  it.each([
    [['ghe.acme.com', 'ghe.acme.com:9443', 'ghe.acme.com:8443']],
    [['ghe.acme.com:8443', 'ghe.acme.com:9443', 'ghe.acme.com']]
  ])(
    'requires exact host:port authentication regardless of auth inventory order: %j',
    async (authenticatedHosts) => {
      mockOriginRemote('https://ghe.acme.com:8443/team/orca.git')
      mockAuthenticatedHosts(authenticatedHosts)

      await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
        owner: 'team',
        repo: 'orca',
        host: 'ghe.acme.com:8443'
      })
    }
  )

  it.each([
    'https://ghe.acme.com:8443/team/orca.git',
    'https://ghe.acme.com:80/team/orca.git',
    'http://ghe.acme.com:443/team/orca.git'
  ])('rejects portless authentication for a non-default web endpoint: %s', async (remoteUrl) => {
    mockOriginRemote(remoteUrl)
    mockHostAuthenticated('ghe.acme.com')

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeNull()
  })

  it.each(['http://ghe.acme.com:80/team/orca.git', 'https://ghe.acme.com:443/team/orca.git'])(
    'matches a protocol-default port to the portless auth host: %s',
    async (remoteUrl) => {
      mockOriginRemote(remoteUrl)
      mockHostAuthenticated('ghe.acme.com')

      await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
        owner: 'team',
        repo: 'orca',
        host: 'ghe.acme.com'
      })
    }
  )

  it('preserves exact authentication for an HTTP endpoint on port 443', async () => {
    mockOriginRemote('http://ghe.acme.com:443/team/orca.git')
    mockHostAuthenticated('ghe.acme.com:443')

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
      owner: 'team',
      repo: 'orca',
      host: 'ghe.acme.com:443'
    })
  })

  it('preserves exact authentication for an HTTPS endpoint on port 80', async () => {
    mockOriginRemote('https://ghe.acme.com:80/team/orca.git')
    mockHostAuthenticated('ghe.acme.com:80')

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
      owner: 'team',
      repo: 'orca',
      host: 'ghe.acme.com:80'
    })
  })

  it('probes gh in the repository WSL runtime, not the host/default distro', async () => {
    mockOriginRemote('https://github.acme-corp.com/team/orca.git')
    mockHostAuthenticated()

    await getEnterpriseGitHubRepoSlug('/repo', null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
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

  it('preserves an indeterminate auth inventory failure so a later probe can recover', async () => {
    mockOriginRemote('git@ghe.acme.com:team/orca.git')
    ghExecFileAsyncMock.mockRejectedValueOnce(
      Object.assign(new Error('not installed'), { stdout: '', stderr: '' })
    )

    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeUndefined()

    mockHostAuthenticated('ghe.acme.com:8443')
    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toEqual({
      owner: 'team',
      repo: 'orca',
      host: 'ghe.acme.com:8443'
    })
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
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], {})
  })

  it('caches per runtime+host so detection polling does not re-spawn gh', async () => {
    mockHostAuthenticated()

    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo')
    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('coalesces concurrent probes for the same runtime and host', async () => {
    let finishProbe: (() => void) | undefined
    ghExecFileAsyncMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishProbe = () =>
            resolve({
              stdout:
                'github.acme-corp.com\n  ✓ Logged in to github.acme-corp.com account kelora (keyring)',
              stderr: ''
            })
        })
    )

    const first = isGitHubHostAuthenticated('github.acme-corp.com', '/repo')
    const second = isGitHubHostAuthenticated('github.acme-corp.com', '/repo')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    finishProbe?.()
    await expect(Promise.all([first, second])).resolves.toEqual([true, true])
  })

  it('does not share cache state across WSL distros', async () => {
    mockHostAuthenticated()

    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo', null, { wslDistro: 'Ubuntu' })
    await isGitHubHostAuthenticated('github.acme-corp.com', '/repo', null, { wslDistro: 'Debian' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('derives cache scope from an implicit WSL UNC repository path', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    ghExecFileAsyncMock.mockImplementation(async (_args: string[], options: { cwd?: string }) => ({
      stdout: options.cwd?.includes('Ubuntu')
        ? 'github.com\n  ✓ Logged in to github.com account other (keyring)'
        : 'github.acme-corp.com\n  ✓ Logged in to github.acme-corp.com account kelora (keyring)',
      stderr: ''
    }))

    try {
      await expect(isGitHubHostAuthenticated('github.acme-corp.com', '/native/repo')).resolves.toBe(
        true
      )
      await expect(
        isGitHubHostAuthenticated(
          'github.acme-corp.com',
          String.raw`\\wsl.localhost\Ubuntu\home\me\repo`
        )
      ).resolves.toBe(false)
      await expect(
        isGitHubHostAuthenticated(
          'github.acme-corp.com',
          String.raw`\\wsl.localhost\Debian\home\me\repo`
        )
      ).resolves.toBe(true)

      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('shares the native gh auth probe across SSH connections', async () => {
    mockHostAuthenticated()

    await isGitHubHostAuthenticated('github.acme-corp.com', '/remote/a', 'ssh-1')
    await isGitHubHostAuthenticated('github.acme-corp.com', '/remote/b', 'ssh-2')

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not target an unconfigured remote host with ambient credentials', async () => {
    mockHostAuthenticated('github.acme-corp.com')

    await expect(isGitHubHostAuthenticated('evil.example.test', '/repo')).resolves.toBe(false)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], { cwd: '/repo' })
    expect(ghExecFileAsyncMock.mock.calls.flat()).not.toContain('evil.example.test')
  })

  it.each([
    [['ghe.acme.com:8443', 'ghe.acme.com:9443']],
    [['ghe.acme.com:9443', 'ghe.acme.com:8443']]
  ])(
    'does not guess between multiple ported auth hosts for one SSH hostname: %j',
    async (authenticatedHosts) => {
      mockAuthenticatedHosts(authenticatedHosts)

      await expect(isGitHubHostAuthenticated('ghe.acme.com', '/repo')).resolves.toBe(false)
    }
  )

  it.each([
    [
      ['ghe.acme.com', false],
      ['ghe.acme.com:8443', true]
    ],
    [
      ['ghe.acme.com:8443', true],
      ['ghe.acme.com', false]
    ]
  ] as const)(
    'keeps exact-port and ambiguous hostname auth cached independently: %j',
    async (...requests) => {
      mockAuthenticatedHosts(['ghe.acme.com:8443', 'ghe.acme.com:9443'])

      for (const [host, expected] of requests) {
        await expect(isGitHubHostAuthenticated(host, '/repo')).resolves.toBe(expected)
      }
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    }
  )

  it('treats default web ports as the same auth host', async () => {
    mockHostAuthenticated('ghe.acme.com:443')

    await expect(isGitHubHostAuthenticated('ghe.acme.com', '/repo')).resolves.toBe(true)
  })

  it('validates a global project host by inventory without targeting it', async () => {
    mockHostAuthenticated('github.acme-corp.com')

    await expect(isGitHubHostAuthenticatedForGlobalCli('evil.example.test')).resolves.toBe(false)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['auth', 'status'], {})
    expect(ghExecFileAsyncMock.mock.calls.flat()).not.toContain('evil.example.test')
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
