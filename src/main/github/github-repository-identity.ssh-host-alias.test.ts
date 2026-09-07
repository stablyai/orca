import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitRunner from '../git/runner'

const {
  commandExecFileAsyncMock,
  getSshGitProviderGenerationMock,
  getSshGitProviderMock,
  gitExecFileAsyncMock,
  resolveWithSshGMock,
  readLocalGitConfigSignatureMock
} = vi.hoisted(() => ({
  commandExecFileAsyncMock: vi.fn(),
  getSshGitProviderGenerationMock: vi.fn(() => 0),
  getSshGitProviderMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  resolveWithSshGMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn(async () => 'sig-10284')
}))

vi.mock('../git/runner', async (importOriginal) => ({
  ...(await importOriginal<typeof GitRunner>()),
  commandExecFileAsync: commandExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock,
  getSshGitProviderGeneration: getSshGitProviderGenerationMock,
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

vi.mock('../ssh/ssh-g-config-resolution', () => ({
  resolveWithSshG: resolveWithSshGMock
}))

import {
  getOwnerRepoForRemote,
  _resetOwnerRepoCache,
  _getOwnerRepoCacheSize
} from './github-repository-identity'
import {
  classifyGitHubOwnerRepoFromRemoteUrl,
  resolveGitHubOwnerRepoFromRemoteUrl,
  _resetSshHostnameResolutionCache
} from './github-ssh-host-alias-resolution'

const REPO = '/tmp/ssh-alias-checkout'

function sshConfig(hostname: string, port = 22) {
  return {
    hostname,
    port,
    identityFile: [],
    identitiesOnly: false,
    forwardAgent: false,
    proxyUseFdpass: false,
    controlMaster: 'no',
    controlPersist: 'no'
  }
}

function mockRemoteUrl(url: string): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: `${url}\n` }
    }
    throw new Error(`unexpected git args: ${args.join(' ')}`)
  })
}

function sshProvider(hostname: string, remoteUrl = 'git@github-work:team/orca.git') {
  return {
    exec: vi.fn().mockResolvedValue({
      stdout: `${remoteUrl}\n`,
      stderr: ''
    }),
    execNonInteractive: vi.fn().mockResolvedValue({
      stdout: `hostname ${hostname}\nport 22\n`,
      stderr: '',
      exitCode: 0,
      timedOut: false,
      canceled: false
    })
  }
}

beforeEach(() => {
  _resetOwnerRepoCache()
  _resetSshHostnameResolutionCache()
  commandExecFileAsyncMock.mockReset()
  getSshGitProviderGenerationMock.mockReset()
  getSshGitProviderGenerationMock.mockReturnValue(0)
  getSshGitProviderMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  resolveWithSshGMock.mockReset()
  readLocalGitConfigSignatureMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('#10284 SSH Host alias → github.com owner/repo', () => {
  it('resolveGitHubOwnerRepoFromRemoteUrl expands HostName ssh.github.com', async () => {
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('ssh.github.com', 443))

    await expect(
      resolveGitHubOwnerRepoFromRemoteUrl('git@github-work:team/orca.git')
    ).resolves.toEqual({ owner: 'team', repo: 'orca' })
    expect(resolveWithSshGMock).toHaveBeenCalledWith('github-work')
  })

  it('getOwnerRepoForRemote resolves SCP alias remote used for multi-account GitHub', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('github.com'))

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).toHaveBeenCalledWith('github-work')
  })

  it('getOwnerRepoForRemote resolves ssh:// Host alias remotes', async () => {
    mockRemoteUrl('ssh://git@github.com-work/acme/widgets.git')
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('ssh.github.com', 443))

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
    expect(resolveWithSshGMock).toHaveBeenCalledWith('github.com-work')
  })

  it('resolves aliases inside the repository WSL runtime', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'hostname github.com\nport 22\n',
      stderr: ''
    })

    await expect(
      getOwnerRepoForRemote(REPO, 'origin', null, { wslDistro: 'Ubuntu' })
    ).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(commandExecFileAsyncMock).toHaveBeenCalledWith('ssh', ['-G', '--', 'github-work'], {
      cwd: REPO,
      timeout: 5_000,
      wslDistro: 'Ubuntu'
    })
    expect(resolveWithSshGMock).not.toHaveBeenCalled()
  })

  it('resolves aliases inside the repository SSH runtime', async () => {
    const provider = sshProvider('github.com')
    getSshGitProviderMock.mockReturnValue(provider)
    getSshGitProviderGenerationMock.mockReturnValue(4)

    await expect(getOwnerRepoForRemote('/remote/repo', 'origin', 'ssh-1')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(provider.execNonInteractive).toHaveBeenCalledWith(
      'ssh',
      ['-G', '--', 'github-work'],
      '/remote/repo',
      5_000
    )
    expect(resolveWithSshGMock).not.toHaveBeenCalled()
  })

  it('does not read an SSH repoPath locally when its provider is missing', async () => {
    getSshGitProviderMock.mockReturnValue(undefined)

    await expect(
      getOwnerRepoForRemote(
        '/remote/repo',
        'origin',
        'ssh-1',
        {},
        {
          requireVerifiedSshProbe: true
        }
      )
    ).rejects.toThrow('Remote connection dropped.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('preserves a one-shot SSH remote failure through candidate discovery', async () => {
    const failure = new Error('relay request failed')
    const provider = {
      exec: vi
        .fn()
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ stdout: 'git@github.com:team/orca.git\n', stderr: '' })
    }
    getSshGitProviderMock.mockReturnValue(provider)

    await expect(
      getOwnerRepoForRemote(
        '/remote/repo',
        'origin',
        'ssh-1',
        {},
        {
          requireVerifiedSshProbe: true
        }
      )
    ).rejects.toBe(failure)
    await expect(getOwnerRepoForRemote('/remote/repo', 'origin', 'ssh-1')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(provider.exec).toHaveBeenCalledTimes(2)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps failed SSH alias classification unverifiable', async () => {
    const provider = sshProvider('')
    getSshGitProviderMock.mockReturnValue(provider)

    await expect(
      getOwnerRepoForRemote(
        '/remote/repo',
        'origin',
        'ssh-1',
        {},
        {
          requireVerifiedSshProbe: true
        }
      )
    ).rejects.toThrow('Remote repository identity is unverifiable.')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('isolates the same alias across native and WSL runtimes', async () => {
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('github.com'))
    commandExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'hostname gitlab.com\nport 22\n',
      stderr: ''
    })

    await expect(
      resolveGitHubOwnerRepoFromRemoteUrl('git@forge-work:team/orca.git')
    ).resolves.toEqual({ owner: 'team', repo: 'orca' })
    await expect(
      resolveGitHubOwnerRepoFromRemoteUrl('git@forge-work:team/orca.git', {
        repoPath: REPO,
        wslDistro: 'Ubuntu'
      })
    ).resolves.toBeNull()
    expect(resolveWithSshGMock).toHaveBeenCalledTimes(1)
    expect(commandExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('invalidates alias resolution when an SSH provider reconnects', async () => {
    const context = { repoPath: '/remote/repo', connectionId: 'ssh-1' }
    getSshGitProviderGenerationMock.mockReturnValue(1)
    getSshGitProviderMock.mockReturnValue(sshProvider('github.com'))

    await expect(
      resolveGitHubOwnerRepoFromRemoteUrl('git@forge-work:team/orca.git', context)
    ).resolves.toEqual({ owner: 'team', repo: 'orca' })

    getSshGitProviderGenerationMock.mockReturnValue(2)
    getSshGitProviderMock.mockReturnValue(sshProvider('gitlab.com'))
    await expect(
      resolveGitHubOwnerRepoFromRemoteUrl('git@forge-work:team/orca.git', context)
    ).resolves.toBeNull()
  })

  it('invalidates owner/repo identity when an SSH provider reconnects', async () => {
    getSshGitProviderGenerationMock.mockReturnValue(1)
    getSshGitProviderMock.mockReturnValue(
      sshProvider('github.com', 'git@github-work:team/orca.git')
    )

    await expect(getOwnerRepoForRemote('/remote/repo', 'origin', 'ssh-1')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })

    getSshGitProviderGenerationMock.mockReturnValue(2)
    getSshGitProviderMock.mockReturnValue(
      sshProvider('github.com', 'git@github-work:acme/widgets.git')
    )
    await expect(getOwnerRepoForRemote('/remote/repo', 'origin', 'ssh-1')).resolves.toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
  })

  it('does not call ssh -G for literal github.com remotes', async () => {
    mockRemoteUrl('git@github.com:team/orca.git')

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).not.toHaveBeenCalled()
  })

  it('does not call ssh -G for https remotes', async () => {
    mockRemoteUrl('https://github.com/team/orca.git')

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).not.toHaveBeenCalled()
  })

  it('returns null when alias resolves to a non-GitHub host', async () => {
    mockRemoteUrl('git@gitlab-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('gitlab.com'))

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
  })

  it('returns null when ssh -G fails for an alias', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValueOnce(null)

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
  })

  it('does not rewrite transport: identity resolution only consumes HostName', async () => {
    const remote = 'git@github-work:team/orca.git'
    mockRemoteUrl(remote)
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('github.com'))

    await getOwnerRepoForRemote(REPO, 'origin')
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      expect.objectContaining({ cwd: REPO })
    )
    const gitArgLists = gitExecFileAsyncMock.mock.calls.map(([args]) => args.join(' '))
    expect(gitArgLists.every((cmd) => cmd.startsWith('remote get-url'))).toBe(true)
  })

  it('classifies ssh -G failure as indeterminate (not stable not-github)', async () => {
    resolveWithSshGMock.mockResolvedValueOnce(null)
    await expect(
      classifyGitHubOwnerRepoFromRemoteUrl('git@github-work:team/orca.git')
    ).resolves.toEqual({ kind: 'indeterminate' })
  })

  it('does not long-negative-cache owner/repo when ssh -G is indeterminate', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValue(null)

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
    expect(_getOwnerRepoCacheSize()).toBe(0)

    _resetSshHostnameResolutionCache()
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
    expect(resolveWithSshGMock).toHaveBeenCalledTimes(2)
    expect(_getOwnerRepoCacheSize()).toBe(0)
  })

  it('does not pin an SSH-config-dependent miss to the Git config signature', async () => {
    vi.useFakeTimers()
    mockRemoteUrl('git@forge-work:team/orca.git')
    resolveWithSshGMock
      .mockResolvedValueOnce(sshConfig('gitlab.com'))
      .mockResolvedValueOnce(sshConfig('github.com'))

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toBeNull()
    await vi.advanceTimersByTimeAsync(60_001)
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
  })

  it('caches a successful HostName expansion so repeat probes skip ssh -G', async () => {
    mockRemoteUrl('git@github-work:team/orca.git')
    resolveWithSshGMock.mockResolvedValue(sshConfig('github.com'))

    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    await expect(getOwnerRepoForRemote(REPO, 'origin')).resolves.toEqual({
      owner: 'team',
      repo: 'orca'
    })
    expect(resolveWithSshGMock).toHaveBeenCalledTimes(1)
  })

  it('isolates case-sensitive OpenSSH Host aliases in the cache', async () => {
    resolveWithSshGMock.mockImplementation(async (host: string) =>
      sshConfig(host === 'GitHub-Work' ? 'github.com' : 'gitlab.com')
    )

    await expect(
      classifyGitHubOwnerRepoFromRemoteUrl('git@GitHub-Work:team/orca.git')
    ).resolves.toEqual({
      kind: 'github',
      ownerRepo: { owner: 'team', repo: 'orca' }
    })
    await expect(
      classifyGitHubOwnerRepoFromRemoteUrl('git@github-work:team/orca.git')
    ).resolves.toEqual({
      kind: 'not-github',
      cacheWithGitConfigSignature: false
    })
    expect(resolveWithSshGMock).toHaveBeenCalledTimes(2)
  })

  it('classifies a resolved non-GitHub HostName as not-github', async () => {
    resolveWithSshGMock.mockResolvedValueOnce(sshConfig('gitlab.com'))
    await expect(
      classifyGitHubOwnerRepoFromRemoteUrl('git@gitlab-work:team/orca.git')
    ).resolves.toEqual({ kind: 'not-github', cacheWithGitConfigSignature: false })
  })
})
