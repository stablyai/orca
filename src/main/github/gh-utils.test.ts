import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../git/command-runner/hosted-cli/gh-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ghExecFileAsync: vi.fn()
}))

import { _resetRemoteNameListingCache } from '../git/remotes/remote-name-listing'
import {
  _getOwnerRepoCacheSize,
  _resetOwnerRepoCache,
  getOwnerRepo,
  getOwnerRepoForRemote
} from './gh-utils'
import { __resetLocalGitConfigSignatureCacheForTests } from './local-git-config-signature'

function gitRemoteGetUrlCalls(remoteName: string): unknown[][] {
  return gitExecFileAsyncMock.mock.calls.filter(
    ([args]) =>
      Array.isArray(args) && args[0] === 'remote' && args[1] === 'get-url' && args[2] === remoteName
  )
}

describe('github owner/repo resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    _resetOwnerRepoCache()
    _resetRemoteNameListingCache()
    __resetLocalGitConfigSignatureCacheForTests()
  })

  it('keeps local host and local WSL owner/repo cache entries separate for the same path', async () => {
    gitExecFileAsyncMock.mockImplementation(
      async (args: string[], options: { wslDistro?: string } = {}) => {
        if (args[0] === 'remote' && args[1] !== 'get-url') {
          return { stdout: 'origin\n' }
        }
        if (args[2] === 'upstream') {
          throw new Error("fatal: No such remote 'upstream'")
        }
        return {
          stdout: options.wslDistro
            ? 'git@github.com:wsl/orca.git\n'
            : 'git@github.com:host/orca.git\n'
        }
      }
    )

    await expect(getOwnerRepo('/repo')).resolves.toEqual({ owner: 'host', repo: 'orca' })
    await expect(getOwnerRepo('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toEqual({
      owner: 'wsl',
      repo: 'orca'
    })
    await expect(getOwnerRepo('/repo', null, { wslDistro: 'Ubuntu' })).resolves.toEqual({
      owner: 'wsl',
      repo: 'orca'
    })

    // 2 runtimes x (1 remote list + 1 origin hit); repeat WSL call is cached.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(gitRemoteGetUrlCalls('upstream')).toHaveLength(0)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      timeout: 30_000
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      timeout: 30_000,
      wslDistro: 'Ubuntu'
    })
  })

  it('does not apply the long negative TTL when git remote get-url fails transiently', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    await writeFile(join(repoPath, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
    try {
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('fatal: cannot lock ref'))
        .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })

      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()
      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toEqual({
        owner: 'acme',
        repo: 'widgets'
      })
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('invalidates a cached local missing remote when an included git config changes', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    const includedConfigPath = join(repoPath, 'remote.inc')
    await writeFile(
      join(repoPath, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = ${includedConfigPath}\n`
    )
    await writeFile(includedConfigPath, '')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error("error: No such remote 'origin'"))
        .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })

      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()
      await writeFile(
        includedConfigPath,
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
      )
      vi.setSystemTime(32_000)

      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toEqual({
        owner: 'acme',
        repo: 'widgets'
      })
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})
