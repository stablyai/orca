import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/types'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const mocks = vi.hoisted(() => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: mocks.getSshGitProvider
}))

const tempDirs: string[] = []

function makeWorktree(path: string): ResolvedRuntimeGitWorktree {
  return {
    id: 'wt-1',
    repoId: 'repo-1',
    path,
    linkedIssue: null,
    git: {
      path,
      branch: 'main',
      isBare: false,
      isMainWorktree: false,
      head: 'a'.repeat(40)
    }
  } as unknown as ResolvedRuntimeGitWorktree
}

describe('RuntimeGitCommands gitignore entries', () => {
  beforeEach(() => {
    mocks.getSshGitProvider.mockReset()
  })

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  it('appends entries in a local worktree', async () => {
    const worktreePath = mkdtempSync(join(tmpdir(), 'orca-runtime-gitignore-'))
    tempDirs.push(worktreePath)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({ worktree: makeWorktree(worktreePath) }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(
      commands.appendRuntimeGitignoreEntries('id:wt-1', [
        { relativePath: 'dist', isDirectory: true }
      ])
    ).resolves.toEqual({ added: ['dist'], alreadyPresent: [] })
    expect(readFileSync(join(worktreePath, '.gitignore'), 'utf8')).toBe('dist/\n')
  })

  it('delegates remote entries to the SSH Git provider', async () => {
    const appendGitignoreEntries = vi
      .fn()
      .mockResolvedValue({ added: ['dist'], alreadyPresent: ['coverage'] })
    mocks.getSshGitProvider.mockReturnValue({ appendGitignoreEntries })
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote/repo'),
        connectionId: 'conn-1'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(
      commands.appendRuntimeGitignoreEntries('id:wt-1', [
        { relativePath: 'coverage', isDirectory: true },
        { relativePath: 'dist', isDirectory: true }
      ])
    ).resolves.toEqual({ added: ['dist'], alreadyPresent: ['coverage'] })
    expect(appendGitignoreEntries).toHaveBeenCalledWith('/remote/repo', [
      { relativePath: 'coverage', isDirectory: true },
      { relativePath: 'dist', isDirectory: true }
    ])
  })
})
