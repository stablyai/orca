import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { gitExecFileAsyncMock, getSshGitProviderMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  getSshGitProviderMock: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  ghExecFileAsync: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

import {
  _getOwnerRepoCacheSize,
  _resetOwnerRepoCache,
  classifyGhError,
  classifyListIssuesError,
  getIssueOwnerRepo,
  getOwnerRepo,
  getOwnerRepoForRemote,
  parseGitHubRemoteIdentity,
  parseGitHubOwnerRepo,
  resolvePRRepositoryCandidates,
  resolveIssueSource
} from './gh-utils'
import {
  __resetLocalGitConfigSignatureCacheForTests,
  readLocalGitConfigSignature
} from './local-git-config-signature'

describe('github owner/repo resolution', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    _resetOwnerRepoCache()
    __resetLocalGitConfigSignatureCacheForTests()
  })

  it('parses GitHub HTTPS and SSH remotes', () => {
    expect(parseGitHubOwnerRepo('https://github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
    expect(parseGitHubOwnerRepo('https://alice@github.com/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
    expect(parseGitHubOwnerRepo('https://github.com:443/acme/widgets.git')).toEqual({
      owner: 'acme',
      repo: 'widgets'
    })
    expect(parseGitHubOwnerRepo('git@github.com:stablyai/orca.git')).toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(parseGitHubOwnerRepo('git@github.com:TheBoredTeam/boring.notch.git')).toEqual({
      owner: 'TheBoredTeam',
      repo: 'boring.notch'
    })
    expect(parseGitHubOwnerRepo('ssh://git@github.com/stablyai/orca.git')).toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(parseGitHubOwnerRepo('ssh://git@ssh.github.com:443/stablyai/orca.git')).toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
    expect(parseGitHubOwnerRepo('git@example.com:stablyai/orca.git')).toBeNull()
  })

  it('parses GitHub Enterprise host identity', () => {
    expect(parseGitHubRemoteIdentity('https://ghe.acme.internal/acme/orca.git')).toEqual({
      host: 'ghe.acme.internal',
      owner: 'acme',
      repo: 'orca'
    })
    expect(parseGitHubRemoteIdentity('git@ghe.acme.internal:acme/orca.git')).toEqual({
      host: 'ghe.acme.internal',
      owner: 'acme',
      repo: 'orca'
    })
    expect(parseGitHubOwnerRepo('https://ghe.acme.internal/acme/orca.git')).toBeNull()
  })

  it('prefers upstream for PR owner/repo resolution (#7331)', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(getOwnerRepo('/repo')).resolves.toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })
  })

  it('resolves GitHub HTTPS origin remotes with user info and a default port', async () => {
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error("fatal: No such remote 'upstream'"))
      .mockResolvedValueOnce({
        stdout: 'https://alice@github.com:443/acme/widgets.git\n'
      })

    await expect(getOwnerRepo('/repo')).resolves.toEqual({ owner: 'acme', repo: 'widgets' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it('prefers upstream for issue owner/repo resolution', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(getIssueOwnerRepo('/repo')).resolves.toEqual({ owner: 'stablyai', repo: 'orca' })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })
  })

  it('falls back to origin when upstream is missing or non-GitHub', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:stablyai/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:fork/orca.git\n' })

    await expect(getIssueOwnerRepo('/repo')).resolves.toEqual({ owner: 'fork', repo: 'orca' })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it('does not mix origin and upstream cache entries for the same repo path', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:fork/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:stablyai/orca.git\n' })

    await expect(getOwnerRepoForRemote('/repo', 'origin')).resolves.toEqual({
      owner: 'fork',
      repo: 'orca'
    })
    await expect(getOwnerRepoForRemote('/repo', 'upstream')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
  })

  it('coalesces concurrent missing remote probes for the same repo and remote', async () => {
    gitExecFileAsyncMock.mockImplementation(async () => {
      await Promise.resolve()
      throw new Error("error: No such remote 'upstream'")
    })

    await expect(
      Promise.all([
        getOwnerRepoForRemote('/repo', 'upstream'),
        getOwnerRepoForRemote('/repo', 'upstream'),
        getOwnerRepoForRemote('/repo', 'upstream'),
        getOwnerRepoForRemote('/repo', 'upstream')
      ])
    ).resolves.toEqual([null, null, null, null])

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'upstream'], {
      cwd: '/repo'
    })

    await expect(getOwnerRepoForRemote('/repo', 'upstream')).resolves.toBeNull()
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('resolves SSH repo remotes through the registered SSH git provider', async () => {
    const sshProvider = {
      exec: vi.fn(async (args: string[]) => {
        if (args[2] === 'upstream') {
          throw new Error("fatal: No such remote 'upstream'")
        }
        return { stdout: 'git@github.com:stablyai/orca.git\n', stderr: '' }
      })
    }
    getSshGitProviderMock.mockReturnValue(sshProvider)

    await expect(getOwnerRepo('/home/user/orca', 'openclaw-2')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(getSshGitProviderMock).toHaveBeenCalledWith('openclaw-2')
    expect(sshProvider.exec).toHaveBeenCalledWith(
      ['remote', 'get-url', 'origin'],
      '/home/user/orca'
    )
  })

  it('keeps local and SSH owner/repo cache entries separate for the same path', async () => {
    const sshProvider = {
      exec: vi.fn().mockResolvedValue({ stdout: 'git@github.com:remote/orca.git\n', stderr: '' })
    }
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'git@github.com:local/orca.git\n' })
    getSshGitProviderMock.mockReturnValue(sshProvider)

    await expect(getOwnerRepo('/repo')).resolves.toEqual({ owner: 'local', repo: 'orca' })
    await expect(getOwnerRepo('/repo', 'ssh-1')).resolves.toEqual({ owner: 'remote', repo: 'orca' })
  })

  it('keeps local host and local WSL owner/repo cache entries separate for the same path', async () => {
    gitExecFileAsyncMock.mockImplementation(
      async (args: string[], options: { wslDistro?: string } = {}) => {
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

    // 2 runtimes x (1 upstream miss + 1 origin hit); repeat WSL call is cached.
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(4)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo',
      wslDistro: 'Ubuntu'
    })
  })

  it('prunes expired distinct owner/repo cache entries on later lookups', async () => {
    const nowSpy = vi.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(1_000)
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'git@github.com:stablyai/orca.git\n'
      })
      await expect(getOwnerRepo('/repo-a')).resolves.toEqual({ owner: 'stablyai', repo: 'orca' })
      expect(_getOwnerRepoCacheSize()).toBe(1)

      nowSpy.mockReturnValue(32_000)
      gitExecFileAsyncMock.mockResolvedValueOnce({
        stdout: 'git@github.com:acme/widgets.git\n'
      })
      await expect(getOwnerRepo('/repo-b')).resolves.toEqual({ owner: 'acme', repo: 'widgets' })

      expect(_getOwnerRepoCacheSize()).toBe(1)
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('resolves PR candidates as upstream then origin and de-dupes matching slugs', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:Acme/Orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/orca.git\n' })

    await expect(resolvePRRepositoryCandidates('/repo')).resolves.toEqual({
      candidates: [{ owner: 'Acme', repo: 'Orca' }],
      headRepo: { owner: 'acme', repo: 'orca' }
    })
  })

  it('ignores non-GitHub upstream while keeping origin as the head repo', async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:Acme/Orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:fork/orca.git\n' })

    await expect(resolvePRRepositoryCandidates('/repo')).resolves.toEqual({
      candidates: [{ owner: 'fork', repo: 'orca' }],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
  })

  it('expires cached remote owner/repo entries after the TTL', async () => {
    vi.useFakeTimers()
    try {
      gitExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: 'git@github.com:old/orca.git\n' })
        .mockResolvedValueOnce({ stdout: 'git@github.com:new/orca.git\n' })

      await expect(getOwnerRepoForRemote('/repo', 'origin')).resolves.toEqual({
        owner: 'old',
        repo: 'orca'
      })
      await expect(getOwnerRepoForRemote('/repo', 'origin')).resolves.toEqual({
        owner: 'old',
        repo: 'orca'
      })
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(30_001)

      await expect(getOwnerRepoForRemote('/repo', 'origin')).resolves.toEqual({
        owner: 'new',
        repo: 'orca'
      })
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps local missing-remote probes cached beyond the short positive TTL', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    await writeFile(join(repoPath, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      gitExecFileAsyncMock.mockRejectedValue(new Error("error: No such remote 'origin'"))

      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()
      vi.setSystemTime(32_000)
      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()

      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('treats stderr-only missing-remote errors as stable negatives', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    await writeFile(join(repoPath, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      gitExecFileAsyncMock.mockRejectedValue(
        Object.assign(new Error('Command failed'), {
          stderr: "fatal: No such remote 'origin'"
        })
      )

      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()
      vi.setSystemTime(32_000)
      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      await rm(repoPath, { recursive: true, force: true })
    }
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

  it('invalidates a cached local missing remote when git config changes', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    const configPath = join(repoPath, '.git', 'config')
    await writeFile(configPath, '[core]\n\trepositoryformatversion = 0\n')
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000)
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error("error: No such remote 'origin'"))
        .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })

      await expect(getOwnerRepoForRemote(repoPath, 'origin')).resolves.toBeNull()
      await writeFile(
        configPath,
        '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
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

  it('tracks included git config paths with inline comments', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    const includedConfigPath = join(repoPath, 'remote-with-comment.inc')
    await writeFile(
      join(repoPath, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = ${includedConfigPath} # origin remote lives here\n`
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

  it('tracks included git config paths when section headers have inline comments', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    const includedConfigPath = join(repoPath, 'section-comment.inc')
    await writeFile(
      join(repoPath, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[include] # comment\n\tpath = ${includedConfigPath}\n`
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

  it('tracks quoted included git config paths with inline comments', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    const includedConfigPath = join(repoPath, 'quoted-comment.inc')
    await writeFile(
      join(repoPath, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = "${includedConfigPath}" # comment\n`
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

  it('tracks quoted included git config paths with comment characters in the path', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    await mkdir(join(repoPath, '.git'))
    const includeDir = join(repoPath, 'include # hash')
    await mkdir(includeDir)
    const includedConfigPath = join(includeDir, 'remote.inc')
    await writeFile(
      join(repoPath, '.git', 'config'),
      `[core]\n\trepositoryformatversion = 0\n[include]\n\tpath = "${includedConfigPath}"\n`
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

  it('includes per-worktree git config in local config signatures', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    const gitDir = join(repoPath, '.git')
    await mkdir(gitDir)
    await writeFile(join(gitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n')
    try {
      const firstSignature = await readLocalGitConfigSignature({
        repoPath,
        connectionId: null
      })

      await writeFile(
        join(gitDir, 'config.worktree'),
        '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
      )
      const secondSignature = await readLocalGitConfigSignature({
        repoPath,
        connectionId: null
      })

      expect(secondSignature).not.toEqual(firstSignature)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('includes linked worktree config in local config signatures', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    const commonGitDir = join(repoPath, 'common-git')
    const worktreeGitDir = join(commonGitDir, 'worktrees', 'feature')
    const worktreePath = join(repoPath, 'feature-worktree')
    await mkdir(worktreeGitDir, { recursive: true })
    await mkdir(worktreePath)
    await writeFile(join(worktreePath, '.git'), `gitdir: ${worktreeGitDir}\n`)
    await writeFile(join(worktreeGitDir, 'commondir'), '../..\n')
    await writeFile(join(commonGitDir, 'config'), '[core]\n\trepositoryformatversion = 0\n')
    try {
      const firstSignature = await readLocalGitConfigSignature({
        repoPath: worktreePath,
        connectionId: null
      })

      await writeFile(
        join(worktreeGitDir, 'config.worktree'),
        '[branch "feature"]\n\tremote = origin\n\tmerge = refs/heads/contributor/original\n'
      )
      const secondSignature = await readLocalGitConfigSignature({
        repoPath: worktreePath,
        connectionId: null
      })

      expect(secondSignature).not.toEqual(firstSignature)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })

  it('tracks includeIf paths with comment markers inside quoted section headers', async () => {
    const repoPath = await mkdtemp(join(tmpdir(), 'orca-gh-utils-'))
    const gitDir = join(repoPath, '.git')
    const includedDir = join(repoPath, 'Work #1')
    const includedConfigPath = join(includedDir, 'included.gitconfig')
    await mkdir(gitDir)
    await mkdir(includedDir)
    await writeFile(
      includedConfigPath,
      '[remote "origin"]\n\turl = git@github.com:acme/widgets.git\n'
    )
    await writeFile(
      join(gitDir, 'config'),
      `[includeIf "gitdir:${includedDir}/"]\n\tpath = "${includedConfigPath}"\n`
    )
    try {
      const firstSignature = await readLocalGitConfigSignature({
        repoPath,
        connectionId: null
      })

      await writeFile(
        includedConfigPath,
        '[remote "origin"]\n\turl = git@github.com:acme/renamed-widgets.git\n'
      )
      const secondSignature = await readLocalGitConfigSignature({
        repoPath,
        connectionId: null
      })

      expect(secondSignature).not.toEqual(firstSignature)
    } finally {
      await rm(repoPath, { recursive: true, force: true })
    }
  })
})

describe('resolveIssueSource', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    getSshGitProviderMock.mockReset()
    _resetOwnerRepoCache()
  })

  it("'auto' + upstream exists → upstream, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })

  it("'auto' + no upstream → origin, fellBack=false", async () => {
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@example.com:stablyai/orca.git\n' })
      .mockResolvedValueOnce({ stdout: 'git@github.com:solo/orca.git\n' })

    await expect(resolveIssueSource('/repo', 'auto')).resolves.toEqual({
      source: { owner: 'solo', repo: 'orca' },
      fellBack: false
    })
  })

  it("'upstream' + upstream exists → upstream, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })

  it("'upstream' + no upstream remote → origin, fellBack=true", async () => {
    // No upstream remote configured — the first call fails.
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fatal: No such remote'))
      .mockResolvedValueOnce({ stdout: 'git@github.com:solo/orca.git\n' })

    await expect(resolveIssueSource('/repo', 'upstream')).resolves.toEqual({
      source: { owner: 'solo', repo: 'orca' },
      fellBack: true
    })
  })

  it("'origin' + upstream exists → origin (ignores upstream), fellBack=false", async () => {
    // Only one gh call should happen — origin. Upstream is never consulted.
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:fork/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: { owner: 'fork', repo: 'orca' },
      fellBack: false
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['remote', 'get-url', 'origin'], {
      cwd: '/repo'
    })
  })

  it("'origin' + no upstream → origin, fellBack=false", async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:solo/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', 'origin')).resolves.toEqual({
      source: { owner: 'solo', repo: 'orca' },
      fellBack: false
    })
  })

  it('undefined preference is treated identically to auto', async () => {
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n'
    })

    await expect(resolveIssueSource('/repo', undefined)).resolves.toEqual({
      source: { owner: 'stablyai', repo: 'orca' },
      fellBack: false
    })
  })
})

describe('gh error classification', () => {
  // Why: a fork with Issues turned off triggers `gh issue list` stderr
  // "the '<slug>' repository has disabled issues". Without a dedicated branch
  // the raw "Command failed: gh issue list …" line leaks into the Tasks banner
  // via the `unknown` fallback — which is what users see when they flip the
  // per-repo selector to an origin fork that has issues disabled.
  it('classifies "has disabled issues" stderr as issues_disabled', () => {
    const stderr =
      "Command failed: gh issue list --limit 36 --json number,title,state --repo brennanb2025/orca --state open\nthe 'brennanb2025/orca' repository has disabled issues"
    expect(classifyGhError(stderr)).toEqual({
      type: 'issues_disabled',
      message: 'Issues are disabled on this repository.'
    })
    expect(classifyListIssuesError(stderr)).toEqual({
      type: 'issues_disabled',
      message: 'Issues are disabled on this repository.'
    })
  })
})
