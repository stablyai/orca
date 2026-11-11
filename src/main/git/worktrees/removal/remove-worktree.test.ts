import { existsSync } from 'node:fs'
import type * as FsPromises from 'node:fs/promises'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const {
  gitExecFileAsyncMock,
  gitExecFileSyncMock,
  translateWslOutputPathsMock,
  statMock,
  readFileMock,
  resolveGitDirMock
} = vi.hoisted(() => ({
  gitExecFileAsyncMock: vi.fn(),
  gitExecFileSyncMock: vi.fn(),
  translateWslOutputPathsMock: vi.fn((output: string) => output),
  statMock: vi.fn(),
  readFileMock: vi.fn(),
  resolveGitDirMock: vi.fn()
}))

vi.mock('../../command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../command-runner/git-exec-file-sync', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileSync: gitExecFileSyncMock
}))

vi.mock('../../command-runner/wsl-path-translation', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  translateWslOutputPaths: translateWslOutputPathsMock
}))

vi.mock('../../source-control/resolve-git-dir', () => ({
  resolveGitDir: resolveGitDirMock
}))

vi.mock('../../source-control/git-read-cache-invalidation', () => ({
  runWithGitReadCacheInvalidation: <T>(run: () => Promise<T>) => run()
}))

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual<typeof FsPromises>('fs/promises')
  return { ...actual, stat: statMock, readFile: readFileMock }
})
import {
  createGitCallReader,
  createGitCommandMocker,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from './remove-worktree-test-harness'

import { removeWorktree } from './worktree-removal'
import { __getSparseCheckoutStateCacheSizeForTests } from '../sparse-checkout/worktree-sparse-checkout-cache'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)
const getGitCalls = createGitCallReader(gitExecFileAsyncMock)

// Pin non-Windows argv; Windows removal also sets core.longpaths.
let platformSpy: MockInstance<() => NodeJS.Platform>

beforeEach(() => {
  resetWorktreeRemovalState()
  platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
})

afterEach(() => {
  platformSpy.mockRestore()
})

describe('removeWorktree', () => {
  beforeEach(() => {
    resetWorktreeGitMocks({
      gitExecFileAsyncMock,
      gitExecFileSyncMock,
      translateWslOutputPathsMock,
      statMock,
      readFileMock,
      resolveGitDirMock
    })
  })

  it('preserves the branch when requested for a pre-existing local branch checkout', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      }
    })

    await removeWorktree('/repo', '/repo-feature', false, { deleteBranch: false })

    const calls = getGitCalls()
    expect(calls).toContain('git worktree remove /repo-feature')
    expect(calls).not.toContain('git worktree prune')
    expect(calls).not.toContain('git branch -d -- feature/test')
    expect(calls).not.toContain('git branch -D -- feature/test')
  })

  it('skips branch deletion when another worktree still points at the branch', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test

worktree /repo-feature-copy
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature-copy
HEAD def456
branch refs/heads/feature/test
`
      },
      'git branch -d -- feature/test': {
        error: new Error(
          "cannot delete branch 'feature/test' used by worktree at '/repo-feature-copy'"
        )
      },
      'git branch -d -- feature/test#2': {
        error: new Error(
          "cannot delete branch 'feature/test' used by worktree at '/repo-feature-copy'"
        )
      }
    })

    await removeWorktree('/repo', '/repo-feature')

    const calls = getGitCalls()
    expect(calls).toEqual(
      expect.arrayContaining([
        'git worktree remove /repo-feature',
        'git branch -d -- feature/test',
        'git worktree prune'
      ])
    )
    expect(calls.filter((call) => call === 'git branch -d -- feature/test')).toHaveLength(2)
    expect(calls).not.toContain('git branch -D -- feature/test')
  })

  it('deletes what Git left of the checkout after a successful remove', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-residue-'))
    const worktreePath = join(scratch, 'feature')
    // Git for Windows leaves junctions and the directories holding them behind yet exits 0.
    await mkdir(join(worktreePath, 'node_modules', 'left-behind'), { recursive: true })
    try {
      mockGitCommands({})

      await removeWorktree('/repo', worktreePath, false, {
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(getGitCalls()).toEqual([`git worktree remove ${worktreePath}`])
      expect(existsSync(worktreePath)).toBe(false)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('leaves a WSL checkout that Git reported removed to the distro', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'orca-remove-residue-wsl-'))
    const worktreePath = join(scratch, 'feature')
    await mkdir(worktreePath, { recursive: true })
    try {
      mockGitCommands({})

      await removeWorktree('/repo', worktreePath, false, {
        wslDistro: 'Ubuntu',
        knownRemovedWorktree: { branch: '', head: '', locked: false }
      })

      expect(existsSync(worktreePath)).toBe(true)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })

  it('preserves Git refusal even when parent status cannot reveal unpublished submodule commits', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
`
      },
      'git worktree list --porcelain#2': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main
`
      },
      'git worktree remove /repo-feature': {
        error: new Error('git worktree remove failed'),
        stderr: 'fatal: working trees containing submodules cannot be moved or removed'
      },
      'git status --porcelain --untracked-files=all': { stdout: '' }
    })

    await expect(removeWorktree('/repo', '/repo-feature')).rejects.toThrow(
      'git worktree remove failed'
    )
    expect(getGitCalls()).not.toContain('git worktree remove --force /repo-feature')
    expect(getGitCalls()).not.toContain('git branch -d -- feature/test')
  })

  it('does not treat dirty-file force as permission to override a lock', async () => {
    mockGitCommands({
      'git worktree list --porcelain': {
        stdout: `worktree /repo
HEAD abc123
branch refs/heads/main

worktree /repo-feature
HEAD def456
branch refs/heads/feature/test
locked active agent session
`
      }
    })

    await expect(removeWorktree('/repo', '/repo-feature', true)).rejects.toThrow(
      'Worktree is locked by Git. Lock reason: active agent session.'
    )
    expect(getGitCalls()).not.toContain('git worktree remove --force /repo-feature')
  })
})
