import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveGitCommandWithoutProbe } from './command-runner/git-command-resolution'

const { gitExecFileAsyncMock } = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn()
}))

vi.mock('./runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock,
  gitExecFileAsyncBuffer: vi.fn(),
  gitOptionalLocksDisabledEnv: (env: NodeJS.ProcessEnv = process.env) => env,
  gitStreamStdout: vi.fn()
}))

import {
  bulkDiscardChanges,
  bulkStageFiles,
  bulkUnstageFiles,
  discardChanges,
  stageFile,
  unstageFile
} from './status'

const worktreePath = path.resolve('repo')
const windowsRelativePath = 'tests\\breakgit'
const wslOptions = { wslDistro: 'Ubuntu' }
const originalPlatform = process.platform

describe('WSL git pathspecs', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'tests/breakgit\0', stderr: '' })
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  })

  it.each(['wsl.localhost', 'wsl$'])(
    'normalizes mutations when the %s cwd alone selects WSL',
    async (host) => {
      const cwd = `\\\\${host}\\Ubuntu\\home\\dev\\repo`
      await stageFile(cwd, windowsRelativePath)
      await unstageFile(cwd, windowsRelativePath)
      await bulkStageFiles(cwd, [windowsRelativePath])
      await bulkUnstageFiles(cwd, [windowsRelativePath])
      await discardChanges(cwd, windowsRelativePath)
      await bulkDiscardChanges(cwd, [windowsRelativePath])

      expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
        ['add', '--', ':(literal)tests/breakgit'],
        ['reset', '--quiet', '--', ':(literal)tests/breakgit'],
        ['add', '--pathspec-from-file=-', '--pathspec-file-nul'],
        ['reset', '--quiet', '--pathspec-from-file=-', '--pathspec-file-nul'],
        ['ls-files', '--error-unmatch', '--', ':(literal)tests/breakgit'],
        ['restore', '--worktree', '--', ':(literal)tests/breakgit'],
        ['ls-files', '-z', '--', ':(literal)tests/breakgit'],
        ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul']
      ])
      const inputs = gitExecFileAsyncMock.mock.calls
        .map(([, options]) => options.stdin)
        .filter((input) => input !== undefined)
      expect(inputs).toEqual(Array(3).fill(':(literal)tests/breakgit\0'))
      for (const [, options] of gitExecFileAsyncMock.mock.calls) {
        expect(options).not.toHaveProperty('wslDistro')
      }
      const [args, options] = gitExecFileAsyncMock.mock.calls[0]
      const resolved = resolveGitCommandWithoutProbe(args, options)
      expect(resolved).toMatchObject({
        binary: 'wsl.exe',
        wsl: { distro: 'Ubuntu', linuxPath: '/home/dev/repo' },
        wslMode: 'non-login-shell'
      })
      expect(resolved.args.slice(0, 5)).toEqual(['-d', 'Ubuntu', '--exec', 'bash', '-c'])
      expect(resolved.args.at(-1)).toContain("'git' 'add' '--' ':(literal)tests/breakgit'")
    }
  )

  it('uses POSIX separators for tracked file mutations executed inside WSL', async () => {
    await stageFile(worktreePath, windowsRelativePath, wslOptions)
    await unstageFile(worktreePath, windowsRelativePath, wslOptions)
    await bulkStageFiles(worktreePath, [windowsRelativePath], wslOptions)
    await bulkUnstageFiles(worktreePath, [windowsRelativePath], wslOptions)
    await discardChanges(worktreePath, windowsRelativePath, wslOptions)
    await bulkDiscardChanges(worktreePath, [windowsRelativePath], wslOptions)

    const pathspecs = gitExecFileAsyncMock.mock.calls.flatMap(([args]) =>
      (args as string[]).filter((arg) => arg.startsWith(':(literal)'))
    )
    expect(pathspecs).toEqual(Array(5).fill(':(literal)tests/breakgit'))
    const inputs = gitExecFileAsyncMock.mock.calls
      .map(([, options]) => options.stdin)
      .filter((input) => input !== undefined)
    expect(inputs).toEqual(Array(3).fill(':(literal)tests/breakgit\0'))
  })

  it('uses POSIX separators when discarding untracked files inside WSL', async () => {
    const repo = await mkdtemp(path.join(tmpdir(), 'orca-wsl-pathspec-'))
    const targetPath = path.resolve(repo, windowsRelativePath)
    await mkdir(path.dirname(targetPath), { recursive: true })
    await writeFile(targetPath, 'untracked')

    try {
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error('not tracked'))
        .mockResolvedValue({ stdout: '', stderr: '' })
      await discardChanges(repo, windowsRelativePath, wslOptions)

      expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
        ['ls-files', '--error-unmatch', '--', ':(literal)tests/breakgit'],
        ['clean', '-ffdx', '--', ':(literal)tests/breakgit']
      ])

      gitExecFileAsyncMock.mockReset()
      gitExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })
      await bulkDiscardChanges(repo, [windowsRelativePath], wslOptions)

      expect(gitExecFileAsyncMock.mock.calls.map(([args]) => args)).toEqual([
        ['ls-files', '-z', '--', ':(literal)tests/breakgit'],
        ['clean', '-ffdx', '--', ':(literal)tests/breakgit']
      ])
    } finally {
      await rm(repo, { recursive: true, force: true })
    }
  })

  it.each(['linux', 'darwin', 'win32'])(
    'preserves backslashes for host Git on %s',
    async (platform) => {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      await stageFile(worktreePath, windowsRelativePath)

      expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
        ['add', '--', ':(literal)tests\\breakgit'],
        {
          cwd: worktreePath
        }
      )
    }
  )
})
