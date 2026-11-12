import { beforeEach, describe, expect, it, vi } from 'vitest'

const { commandExecFileAsyncMock, ghExecFileAsyncMock, gitExecFileAsyncMock, resolveWithSshGMock } =
  vi.hoisted(() => ({
    commandExecFileAsyncMock: vi.fn(),
    ghExecFileAsyncMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    resolveWithSshGMock: vi.fn()
  }))

// Mock only execution so identity, runtime and auth-status parsing remain real.
vi.mock('../git/command-runner/process-capture/command-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  commandExecFileAsync: commandExecFileAsyncMock
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../ssh/config/ssh-g-config-resolution', () => ({
  resolveWithSshG: resolveWithSshGMock
}))
import {
  _resetGitHubHostAuthCache,
  getEnterpriseGitHubRepoSlug,
  isGitHubHostAuthenticated
} from './github-enterprise-repository'
import { _resetSshHostnameResolutionCache } from './github-ssh-host-alias-resolution'
import { getRepoUpstream, probeRepoUpstream } from './client/fetch/repo-slug-upstream'
import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

function mockOriginRemote(url: string): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: `${url}\n`, stderr: '' }
    }
    return { stdout: '', stderr: '' }
  })
}

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

describe('getEnterpriseGitHubRepoSlug', () => {
  beforeEach(() => {
    commandExecFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    resolveWithSshGMock.mockReset()
    resolveWithSshGMock.mockResolvedValue(null)
    _resetGitHubHostAuthCache()
    _resetSshHostnameResolutionCache()
    _resetOriginGitHubApiRepositoryCache()
  })

  it.each([
    ['https://bitbucket.org/team/orca.git', 'bitbucket.org'],
    ['ssh://git@altssh.gitlab.com:443/team/orca.git', 'altssh.gitlab.com'],
    ['https://codeberg.org/team/orca.git', 'codeberg.org']
  ])('does not promote a foreign public remote from gh inventory: %s', async (url, host) => {
    mockOriginRemote(url)
    mockHostAuthenticated(host)
    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeFalsy()
    await expect(isGitHubHostAuthenticated(host, '/repo')).resolves.toBe(false)
  })

  it('uses the effective SSH hostname before admitting an Enterprise identity', async () => {
    mockOriginRemote('git@work-forge:team/orca.git')
    resolveWithSshGMock.mockResolvedValue({ hostname: 'bitbucket.org' })
    mockHostAuthenticated('bitbucket.org')
    await expect(getEnterpriseGitHubRepoSlug('/repo')).resolves.toBeNull()
  })

  it.each([
    'https://ghe.acme.com:8443/team/orca.git',
    'https://ghe.acme.com:80/team/orca.git',
    'http://ghe.acme.com:443/team/orca.git'
  ])('rejects portless authentication for a non-default web endpoint: %s', async (remoteUrl) => {
    mockOriginRemote(remoteUrl)
    mockHostAuthenticated('ghe.acme.com')

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

  it.each([true, false])(
    'keeps the literal Enterprise host fallback when SSH expansion fails (authenticated=%s)',
    async (authenticated) => {
      mockOriginRemote('git@ghe.corp.example:org/app.git')
      ghExecFileAsyncMock.mockImplementation(async (args: string[]) => ({
        stdout:
          args[0] === 'auth'
            ? authenticated
              ? 'ghe.corp.example\n  ✓ Logged in to ghe.corp.example account kelora (keyring)'
              : ''
            : JSON.stringify({ isFork: true, parent: { owner: { login: 'parent' }, name: 'app' } }),
        stderr: ''
      }))
      const expected = { owner: 'parent', repo: 'app', host: 'ghe.corp.example' }
      const result = await probeRepoUpstream('/repo')
      expect(result.upstream).toEqual(authenticated ? expected : undefined)
      await expect(getRepoUpstream('/repo')).resolves.toEqual(authenticated ? expected : null)
      expect(ghExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'repo')).toHaveLength(
        authenticated ? 2 : 0
      )
    }
  )
})

describe('isGitHubHostAuthenticated', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    _resetGitHubHostAuthCache()
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

  it('does not share a cached answer between SSH connections at the same path', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout:
          'github.acme-corp.com\n  ✓ Logged in to github.acme-corp.com account kelora (keyring)',
        stderr: ''
      })
      .mockResolvedValueOnce({
        stdout: 'github.com\n  ✓ Logged in to github.com account kelora (keyring)',
        stderr: ''
      })

    await expect(isGitHubHostAuthenticated('github.acme-corp.com', '/repo', 'ssh-1')).resolves.toBe(
      true
    )
    await expect(isGitHubHostAuthenticated('github.acme-corp.com', '/repo', 'ssh-2')).resolves.toBe(
      false
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  // Same-path repositories on separate runtimes must retain separate auth answers.
  it.each([
    ['local resolves first', [null, 'ssh-1'] as const, [true, false]],
    ['connection resolves first', ['ssh-1', null] as const, [false, true]]
  ])(
    'does not cross-attribute auth between a local and a connection-backed repo at the same path (%s)',
    async (_label, connectionIds, expected) => {
      ghExecFileAsyncMock.mockImplementation(
        async (_args: string[], options: { cwd?: string }) => ({
          stdout: options.cwd
            ? 'github.acme-corp.com\n  ✓ Logged in to github.acme-corp.com account kelora (keyring)'
            : 'github.com\n  ✓ Logged in to github.com account kelora (keyring)',
          stderr: ''
        })
      )

      for (const [index, connectionId] of connectionIds.entries()) {
        await expect(
          isGitHubHostAuthenticated('github.acme-corp.com', '/repo', connectionId)
        ).resolves.toBe(expected[index])
      }
      expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    }
  )

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
})
