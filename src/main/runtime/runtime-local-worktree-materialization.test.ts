import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorktreeConfiguredPathResolveResult } from '../git/worktree-configured-path-skips'
import type { SkippedWorktreeCopyPath } from '../ipc/worktree-include-copy-budget'

const emptyResolved = (): WorktreeConfiguredPathResolveResult => ({ paths: [], skipped: [] })

const mocks = vi.hoisted(() => ({
  createWorktreeCopiedPaths: vi.fn(async (): Promise<SkippedWorktreeCopyPath[]> => []),
  createWorktreeLinkedPaths: vi.fn(async () => undefined),
  createWorktreeSharedPaths: vi.fn(async () => undefined),
  resolveWorktreeIncludePaths: vi.fn(async (): Promise<WorktreeConfiguredPathResolveResult> => ({
    paths: [],
    skipped: []
  })),
  resolveWorktreeSharedDirectories: vi.fn(
    async (): Promise<WorktreeConfiguredPathResolveResult> => ({ paths: [], skipped: [] })
  )
}))

vi.mock('../ipc/worktree-symlinks', () => ({
  createWorktreeCopiedPaths: mocks.createWorktreeCopiedPaths,
  createWorktreeLinkedPaths: mocks.createWorktreeLinkedPaths,
  createWorktreeSharedPaths: mocks.createWorktreeSharedPaths
}))
vi.mock('../git/worktree-include-file', () => ({
  resolveWorktreeIncludePaths: mocks.resolveWorktreeIncludePaths
}))
vi.mock('../git/worktree-shared-directories', () => ({
  resolveWorktreeSharedDirectories: mocks.resolveWorktreeSharedDirectories
}))

import { materializeRuntimeLocalWorktree } from './runtime-local-worktree-materialization'

function materializeArgs() {
  const store = {
    getProjectHostSetups: () => [],
    setWorktreeMeta: vi.fn((_id: string, updates: unknown) => ({
      ...(updates as object),
      hostId: 'local'
    }))
  }
  return {
    request: {},
    repo: {
      id: 'repo-1',
      path: '/repo',
      displayName: 'Repo',
      badgeColor: '#000000',
      addedAt: 1,
      symlinkPaths: [] as string[]
    },
    store,
    settings: { workspaceDir: '/worktrees', nestWorkspaces: true },
    created: {
      path: '/worktrees/app',
      head: 'abc123',
      branch: 'feature/app',
      isBare: false,
      isMainWorktree: false
    },
    remoteTrackingBase: null,
    sparseDirectories: [],
    checkoutExistingBranch: false,
    baseBranch: 'main',
    branchName: 'feature/app',
    effectiveRequestedName: 'app',
    effectiveSanitizedName: 'app',
    localWorktreeGitOptions: {},
    onMetadataPersisted: () => null
  }
}

describe('materializeRuntimeLocalWorktree', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    mocks.createWorktreeCopiedPaths.mockReset().mockResolvedValue([])
    mocks.createWorktreeLinkedPaths.mockReset().mockResolvedValue(undefined)
    mocks.createWorktreeSharedPaths.mockReset().mockResolvedValue(undefined)
    mocks.resolveWorktreeIncludePaths.mockReset().mockResolvedValue(emptyResolved())
    mocks.resolveWorktreeSharedDirectories.mockReset().mockResolvedValue(emptyResolved())
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('records lineage immediately after metadata and before filesystem setup', async () => {
    const order: string[] = []
    mocks.createWorktreeLinkedPaths.mockImplementationOnce(async () => {
      order.push('filesystem')
      throw new Error('link failed')
    })
    const args = materializeArgs()
    args.repo.symlinkPaths = ['node_modules']
    args.onMetadataPersisted = () => {
      order.push('metadata')
      return null
    }

    await expect(materializeRuntimeLocalWorktree(args as never)).rejects.toThrow('link failed')

    expect(order).toEqual(['metadata', 'filesystem'])
  })

  it('surfaces a skipped include in the create warning with path and reason', async () => {
    mocks.resolveWorktreeIncludePaths.mockResolvedValue({
      paths: [],
      skipped: [{ mechanism: 'include', path: 'node_modules', reason: 'not-gitignored' as const }]
    })

    const result = await materializeRuntimeLocalWorktree(materializeArgs() as never)

    expect(result.includeCopyWarning).toBe('include: node_modules skipped (not gitignored)')
    expect(result.skipWarnings).toEqual([
      expect.objectContaining({
        code: 'WORKTREE_INCLUDE_SKIPPED',
        message: 'include: node_modules skipped (not gitignored)'
      })
    ])
  })

  it('surfaces a skipped share in the create warning with path and reason', async () => {
    mocks.resolveWorktreeSharedDirectories.mockResolvedValue({
      paths: [],
      skipped: [{ mechanism: 'share', path: 'foo', reason: 'not-gitignored' as const }]
    })

    const result = await materializeRuntimeLocalWorktree(materializeArgs() as never)

    expect(result.includeCopyWarning).toBe('share: foo skipped (not gitignored)')
    expect(result.skipWarnings).toEqual([
      expect.objectContaining({
        code: 'WORKTREE_SHARE_SKIPPED',
        message: 'share: foo skipped (not gitignored)'
      })
    ])
  })

  it('names a copy-budget skip so an over-budget include is not a silent success', async () => {
    mocks.resolveWorktreeIncludePaths.mockResolvedValue({
      paths: ['node_modules'],
      skipped: []
    })
    mocks.createWorktreeCopiedPaths.mockResolvedValue([
      { path: 'node_modules', reason: 'entries' as const }
    ])

    const result = await materializeRuntimeLocalWorktree(materializeArgs() as never)

    expect(result.includeCopyWarning).toContain('node_modules')
    expect(result.skipWarnings).toEqual([
      expect.objectContaining({
        code: 'WORKTREE_INCLUDE_SKIPPED',
        message: 'include: node_modules skipped (exceeds copy budget)'
      })
    ])
  })

  it('keeps a successful share free of skip warnings', async () => {
    mocks.resolveWorktreeSharedDirectories.mockResolvedValue({
      paths: ['node_modules'],
      skipped: []
    })

    const result = await materializeRuntimeLocalWorktree(materializeArgs() as never)

    expect(mocks.createWorktreeSharedPaths).toHaveBeenCalledWith('/repo', '/worktrees/app', [
      'node_modules'
    ])
    expect(result.includeCopyWarning).toBeUndefined()
    expect(result.skipWarnings).toEqual([])
  })
})
