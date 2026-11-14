import type * as CommandExecFileModule from '../../git/command-runner/process-capture/command-exec-file'
import type * as GitExecFileModule from '../../git/command-runner/git-exec-file'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  commandExecFileAsyncMock,
  gitExecFileAsyncMock,
  resolveWithSshGMock,
  readLocalGitConfigSignatureMock
} = vi.hoisted(() => ({
  commandExecFileAsyncMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  resolveWithSshGMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn(async () => 'sig-10284')
}))

vi.mock('../../git/command-runner/process-capture/command-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof CommandExecFileModule>()),
  commandExecFileAsync: commandExecFileAsyncMock
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

vi.mock('../../ssh/config/ssh-g-config-resolution', () => ({
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

beforeEach(() => {
  _resetOwnerRepoCache()
  _resetSshHostnameResolutionCache()
  commandExecFileAsyncMock.mockReset()
  gitExecFileAsyncMock.mockReset()
  resolveWithSshGMock.mockReset()
  readLocalGitConfigSignatureMock.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('#10284 SSH Host alias → github.com owner/repo', () => {
  it('does not read an SSH repoPath locally when its provider is missing', async () => {
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
})
