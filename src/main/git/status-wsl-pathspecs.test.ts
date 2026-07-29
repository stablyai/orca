import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

describe('WSL git pathspecs', () => {
  beforeEach(() => {
    gitExecFileAsyncMock.mockReset()
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'tests/breakgit\0', stderr: '' })
  })

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
    expect(pathspecs).toEqual(Array(8).fill(':(literal)tests/breakgit'))
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

  it('preserves backslashes for host Git where they can be literal filename characters', async () => {
    await stageFile(worktreePath, windowsRelativePath)

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['add', '--', ':(literal)tests\\breakgit'], {
      cwd: worktreePath
    })
  })
})
