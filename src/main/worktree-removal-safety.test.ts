import { describe, expect, it, vi } from 'vitest'
import { homedir } from 'node:os'
import type { GitWorktreeInfo } from '../shared/types'
import {
  canCleanupUnregisteredOrcaLeftoverDirectory,
  canSafelyRemoveOrphanedWorktreeDirectory,
  getRegisteredDeletableWorktree
} from './worktree-removal-safety'

function makeGitWorktree(path: string, isMainWorktree = false): GitWorktreeInfo {
  return {
    path,
    head: 'abc123',
    branch: isMainWorktree ? 'refs/heads/main' : `refs/heads/${path.split('/').at(-1)}`,
    isBare: false,
    isMainWorktree
  }
}

function missingPath(path: string): Error & { code: string } {
  return Object.assign(new Error(`missing ${path}`), { code: 'ENOENT' })
}

function makeStatPath(filePaths: readonly string[], directoryPaths: readonly string[] = []) {
  const files = new Set(filePaths)
  const directories = new Set(directoryPaths)
  return async (path: string) => {
    if (files.has(path)) {
      return { type: 'file' }
    }
    if (directories.has(path)) {
      return { type: 'directory' }
    }
    throw missingPath(path)
  }
}

function makeReadPath(entries: readonly (readonly [string, unknown])[]) {
  const files = new Map(entries)
  return async (path: string) => {
    if (!files.has(path)) {
      throw missingPath(path)
    }
    return files.get(path)
  }
}

async function withProcessPlatform<T>(
  platform: NodeJS.Platform,
  callback: () => Promise<T>
): Promise<T> {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: platform })
  try {
    return await callback()
  } finally {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
  }
}

describe('getRegisteredDeletableWorktree', () => {
  it('rejects deleting a worktree that contains another registered worktree', () => {
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeGitWorktree('/repo', true),
        makeGitWorktree('/workspaces/parent'),
        makeGitWorktree('/workspaces/parent/child')
      ])
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/child'
    )
  })

  it('does not reject sibling worktree paths that only share a prefix', () => {
    expect(
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeGitWorktree('/repo', true),
        makeGitWorktree('/workspaces/parent'),
        makeGitWorktree('/workspaces/parent-copy')
      ])
    ).toMatchObject({ path: '/workspaces/parent' })
  })

  it('rejects deleting a worktree that contains another registered worktree in a dotdot-prefixed child', () => {
    expect(() =>
      getRegisteredDeletableWorktree('/repo', '/workspaces/parent', [
        makeGitWorktree('/repo', true),
        makeGitWorktree('/workspaces/parent'),
        makeGitWorktree('/workspaces/parent/..child')
      ])
    ).toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/parent/..child'
    )
  })
})

describe('canSafelyRemoveOrphanedWorktreeDirectory', () => {
  it('accepts a linked worktree .git file that points at this repo worktrees entry', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n'],
          ['/repo/.git/worktrees/orphan/gitdir', '/workspaces/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('accepts repo worktree admin entries with dotdot-prefixed directory names', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/..orphan\n'],
          ['/repo/.git/worktrees/..orphan/gitdir', '/workspaces/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('accepts remote filesystem provider readFile results for linked worktree .git files', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          [
            '/workspaces/orphan/.git',
            { isBinary: false, content: 'gitdir: /repo/.git/worktrees/orphan\n' }
          ],
          [
            '/repo/.git/worktrees/orphan/gitdir',
            { isBinary: false, content: '/workspaces/orphan/.git\n' }
          ]
        ])
      )
    ).resolves.toBe(true)
  })

  it('preserves forward-slash UNC roots when probing linked worktree .git files', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '//Server/Share/orphan',
        '//Server/Repo',
        makeStatPath(['\\\\Server\\Share\\orphan\\.git'], ['\\\\Server\\Repo\\.git']),
        makeReadPath([
          ['\\\\Server\\Share\\orphan\\.git', 'gitdir: //Server/Repo/.git/worktrees/orphan\n'],
          ['\\\\Server\\Repo\\.git\\worktrees\\orphan\\gitdir', '//Server/Share/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('rejects a plain .git directory for unregistered cleanup', async () => {
    const readPath = vi.fn()

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        async () => ({ type: 'directory' }),
        readPath
      )
    ).resolves.toBe(false)

    expect(readPath).not.toHaveBeenCalled()
  })

  it('rejects a gitdir file that points outside this repo worktrees directory', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([
          [
            '/workspaces/orphan/.git',
            { isBinary: false, content: 'gitdir: /other/.git/worktrees/orphan\n' }
          ]
        ])
      )
    ).resolves.toBe(false)
  })

  it('rejects a copied .git file when the admin entry points at another candidate path', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/reused',
        '/repo',
        makeStatPath(['/workspaces/reused/.git'], ['/repo/.git']),
        makeReadPath([
          ['/workspaces/reused/.git', 'gitdir: /repo/.git/worktrees/other\n'],
          ['/repo/.git/worktrees/other/gitdir', '/workspaces/other/.git\n']
        ])
      )
    ).resolves.toBe(false)
  })

  it('rejects POSIX admin backlinks that differ only by case', async () => {
    await withProcessPlatform('win32', async () => {
      await expect(
        canSafelyRemoveOrphanedWorktreeDirectory(
          '/workspaces/reused',
          '/repo',
          makeStatPath(['/workspaces/reused/.git'], ['/repo/.git']),
          makeReadPath([
            ['/workspaces/reused/.git', 'gitdir: /repo/.git/worktrees/reused\n'],
            ['/repo/.git/worktrees/reused/gitdir', '/workspaces/Reused/.git\n']
          ])
        )
      ).resolves.toBe(false)
    })
  })

  it('accepts a pruned admin entry when the candidate .git points under this repo worktrees dir', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git']),
        makeReadPath([['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n']])
      )
    ).resolves.toBe(true)
  })

  it('rejects existing admin entries with a missing gitdir backlink', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git'], ['/repo/.git', '/repo/.git/worktrees/orphan']),
        makeReadPath([['/workspaces/orphan/.git', 'gitdir: /repo/.git/worktrees/orphan\n']])
      )
    ).resolves.toBe(false)
  })

  it('rejects symlink .git entries from remote lstat-shaped providers', async () => {
    const readPath = vi.fn()

    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        async () => ({ type: 'symlink' }),
        readPath
      )
    ).resolves.toBe(false)

    expect(readPath).not.toHaveBeenCalled()
  })

  it('rejects separate-git-dir sibling repos when the admin gitdir is missing', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repo',
        makeStatPath(['/workspaces/orphan/.git', '/repo/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /git/other.git\n'],
          ['/repo/.git', 'gitdir: /git/repo.git\n']
        ])
      )
    ).resolves.toBe(false)
  })

  it('rejects separate git dirs under worktrees when the admin gitdir is missing', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/reused',
        '/repo',
        makeStatPath(['/workspaces/reused/.git', '/repo/.git']),
        makeReadPath([
          ['/workspaces/reused/.git', 'gitdir: /git/worktrees/other.git\n'],
          ['/repo/.git', 'gitdir: /git/worktrees/repo.git\n']
        ])
      )
    ).resolves.toBe(false)
  })

  it('accepts a repo path that is itself a linked worktree', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/workspaces/orphan',
        '/repos/main-linked',
        makeStatPath(['/workspaces/orphan/.git', '/repos/main-linked/.git']),
        makeReadPath([
          ['/workspaces/orphan/.git', 'gitdir: /common/.git/worktrees/orphan\n'],
          ['/repos/main-linked/.git', 'gitdir: /common/.git/worktrees/main-linked\n'],
          ['/common/.git/worktrees/main-linked/gitdir', '/repos/main-linked/.git\n'],
          ['/common/.git/worktrees/orphan/gitdir', '/workspaces/orphan/.git\n']
        ])
      )
    ).resolves.toBe(true)
  })

  it('rejects POSIX home directories even when host homedir has a different path shape', async () => {
    await expect(
      canSafelyRemoveOrphanedWorktreeDirectory(
        '/home/dev',
        '/repos/main',
        makeStatPath(['/home/dev/.git'], ['/repos/main/.git']),
        makeReadPath([
          ['/home/dev/.git', 'gitdir: /repos/main/.git/worktrees/dev\n'],
          ['/repos/main/.git/worktrees/dev/gitdir', '/home/dev/.git\n']
        ])
      )
    ).resolves.toBe(false)
  })
})

describe('canCleanupUnregisteredOrcaLeftoverDirectory', () => {
  const repo = { path: '/repos/main' }
  const ownedMeta = { orcaCreatedAt: 1, orcaCreationSource: 'runtime' as const }
  const baseArgs = {
    meta: ownedMeta,
    worktreePath: '/workspaces/orca-owned',
    runtimeWorktreePath: '/workspaces/orca-owned',
    repo,
    runtimeRepoPath: repo.path,
    knownOrcaLayouts: [],
    registeredWorktrees: [makeGitWorktree(repo.path, true)]
  }

  it('rejects unregistered existing targets that are files or symlinks', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        statPath: makeStatPath(['/workspaces/orca-owned']),
        isGitRepository
      })
    ).resolves.toBe(false)
    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        statPath: async (path) => {
          if (path === '/workspaces/orca-owned') {
            return { type: 'symlink' }
          }
          throw missingPath(path)
        },
        isGitRepository
      })
    ).resolves.toBe(false)

    expect(isGitRepository).not.toHaveBeenCalled()
  })

  it('rejects unregistered leftover directories with a .git marker', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        statPath: makeStatPath(['/workspaces/orca-owned/.git'], ['/workspaces/orca-owned']),
        isGitRepository
      })
    ).resolves.toBe(false)

    expect(isGitRepository).not.toHaveBeenCalled()
  })

  it('rejects no-marker cleanup when only the Orca path shape matches', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        meta: undefined,
        knownOrcaLayouts: [{ path: '/workspaces', nestWorkspaces: false }],
        statPath: makeStatPath([], ['/workspaces/orca-owned']),
        isGitRepository
      })
    ).resolves.toBe(false)

    expect(isGitRepository).not.toHaveBeenCalled()
  })

  it('checks dangerous paths in the original path space before runtime translation', async () => {
    const homePath = homedir()
    const runtimeHomePath = homePath
      .replace(/^([A-Za-z]):/, (_match, drive: string) => `/mnt/${drive.toLowerCase()}`)
      .replace(/\\/g, '/')
    const isGitRepository = vi.fn().mockResolvedValue(false)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        worktreePath: homePath,
        runtimeWorktreePath: runtimeHomePath,
        repo: { path: 'C:\\repos\\main' },
        runtimeRepoPath: '/mnt/c/repos/main',
        registeredWorktrees: [makeGitWorktree('C:\\repos\\main', true)],
        statPath: makeStatPath([], [runtimeHomePath]),
        isGitRepository
      })
    ).resolves.toBe(false)

    expect(isGitRepository).not.toHaveBeenCalled()
  })

  it('checks dangerous POSIX runtime home paths before no-marker cleanup', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(false)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        worktreePath: '/home/dev',
        runtimeWorktreePath: '/home/dev',
        repo: { path: '/repos/main' },
        runtimeRepoPath: '/repos/main',
        registeredWorktrees: [makeGitWorktree('/repos/main', true)],
        statPath: makeStatPath([], ['/home/dev']),
        isGitRepository
      })
    ).resolves.toBe(false)

    expect(isGitRepository).not.toHaveBeenCalled()
  })

  it('rejects unregistered leftover directories that still answer git status', async () => {
    const isGitRepository = vi.fn().mockResolvedValue(true)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        statPath: makeStatPath([], ['/workspaces/orca-owned']),
        isGitRepository
      })
    ).resolves.toBe(false)

    expect(isGitRepository).toHaveBeenCalledWith('/workspaces/orca-owned')
  })

  it('rejects unregistered leftover directories that contain a registered child worktree', async () => {
    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        registeredWorktrees: [
          makeGitWorktree(repo.path, true),
          makeGitWorktree('/workspaces/orca-owned/child')
        ],
        statPath: makeStatPath([], ['/workspaces/orca-owned']),
        isGitRepository: vi.fn().mockResolvedValue(false)
      })
    ).rejects.toThrow(
      'Refusing to delete worktree because it contains another registered worktree: /workspaces/orca-owned/child'
    )
  })

  it('uses runtime paths for filesystem proof and original paths for nested worktree checks', async () => {
    const statPath = vi.fn(async (path: string) => {
      if (path === '/mnt/c/workspaces/orca-owned') {
        return { type: 'directory' }
      }
      throw missingPath(path)
    })
    const isGitRepository = vi.fn().mockResolvedValue(false)

    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        worktreePath: 'C:\\workspaces\\orca-owned',
        runtimeWorktreePath: '/mnt/c/workspaces/orca-owned',
        repo: { path: 'C:\\repos\\main' },
        runtimeRepoPath: '/mnt/c/repos/main',
        registeredWorktrees: [
          makeGitWorktree('C:\\repos\\main', true),
          makeGitWorktree('C:\\workspaces\\orca-owned-sibling')
        ],
        statPath,
        isGitRepository
      })
    ).resolves.toBe(true)

    expect(statPath).toHaveBeenCalledWith('/mnt/c/workspaces/orca-owned')
    expect(statPath).toHaveBeenCalledWith('/mnt/c/workspaces/orca-owned/.git')
    expect(statPath).not.toHaveBeenCalledWith('C:\\workspaces\\orca-owned')
    expect(isGitRepository).toHaveBeenCalledWith('/mnt/c/workspaces/orca-owned')
  })

  it('rejects translated-runtime cleanup when original path contains a registered child', async () => {
    await expect(
      canCleanupUnregisteredOrcaLeftoverDirectory({
        ...baseArgs,
        worktreePath: 'C:\\workspaces\\orca-owned',
        runtimeWorktreePath: '/mnt/c/workspaces/orca-owned',
        repo: { path: 'C:\\repos\\main' },
        runtimeRepoPath: '/mnt/c/repos/main',
        registeredWorktrees: [
          makeGitWorktree('C:\\repos\\main', true),
          makeGitWorktree('C:\\workspaces\\orca-owned\\child')
        ],
        statPath: makeStatPath([], ['/mnt/c/workspaces/orca-owned']),
        isGitRepository: vi.fn().mockResolvedValue(false)
      })
    ).rejects.toThrow(
      'Refusing to delete worktree because it contains another registered worktree: C:\\workspaces\\orca-owned\\child'
    )
  })
})
