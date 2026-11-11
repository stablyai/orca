import type * as FsPromises from 'node:fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../../../../shared/git/worktrees/git-worktree-admin', () => ({
  annotateWorktreeLocksFromAdmin: async (_repoPath: string, rows: unknown[]) => rows
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
  createGitCommandMocker,
  resetWorktreeGitMocks,
  resetWorktreeRemovalState
} from '../removal/remove-worktree-test-harness'

import { listWorktrees } from './worktree-scan-cache'

const mockGitCommands = createGitCommandMocker(gitExecFileAsyncMock)

beforeEach(() => {
  resetWorktreeRemovalState()
})

describe('listWorktrees', () => {
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

  it('bounds concurrent sparse-checkout filesystem probes', async () => {
    const worktreeCount = 20
    const sparseWorktreePath = '/repo-worktree-17'
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: Array.from({ length: worktreeCount }, (_, index) =>
        [
          `worktree ${index === 0 ? '/repo' : `/repo-worktree-${index}`}`,
          `HEAD ${String(index).padStart(6, '0')}`,
          `branch refs/heads/${index === 0 ? 'main' : `feature/${index}`}`,
          ''
        ].join('\n')
      ).join('\n'),
      stderr: ''
    })

    const pendingProbeResolves: (() => void)[] = []
    let activeProbes = 0
    let maxActiveProbes = 0
    statMock.mockImplementation(async (filePath: string) => {
      activeProbes += 1
      maxActiveProbes = Math.max(maxActiveProbes, activeProbes)
      await new Promise<void>((resolve) => pendingProbeResolves.push(resolve))
      activeProbes -= 1

      if (filePath.replaceAll('\\', '/').includes(sparseWorktreePath)) {
        return { isFile: () => true, size: 32 }
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    let completed = false
    const listPromise = listWorktrees('/repo').finally(() => {
      completed = true
    })

    for (let attempt = 0; pendingProbeResolves.length < 8 && attempt < 50; attempt += 1) {
      await Promise.resolve()
    }
    expect(pendingProbeResolves).toHaveLength(8)

    // Drain until settlement: probes may chain additional microtasks after stat.
    for (let attempt = 0; !completed && attempt < 100; attempt += 1) {
      pendingProbeResolves.splice(0).forEach((resolve) => resolve())
      await Promise.resolve()
      await Promise.resolve()
    }
    expect(completed).toBe(true)

    const worktrees = await listPromise

    expect(maxActiveProbes).toBeLessThanOrEqual(8)
    expect(statMock).toHaveBeenCalledTimes(worktreeCount)
    expect(worktrees).toHaveLength(worktreeCount)
    expect(worktrees[17]).toMatchObject({
      path: sparseWorktreePath,
      isSparse: true
    })
  })

  it('annotates missing linked worktrees as prunable via the line-block fallback', async () => {
    // Older Git omits prunable fields, so fallback must verify linked paths on disk.
    mockGitCommands({
      'git worktree list --porcelain -z': {
        error: Object.assign(new Error("unknown switch `z'"), {
          stderr: "error: unknown switch `z'"
        })
      },
      'git worktree list --porcelain': {
        stdout:
          'worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\n' +
          'worktree /repo-feature\nHEAD def456\nbranch refs/heads/feature/test\n\n' +
          'worktree /repo-locked\nHEAD aaa789\nbranch refs/heads/agent\nlocked agent session\n'
      }
    })

    const worktrees = await listWorktrees('/repo')

    expect(worktrees.find((worktree) => worktree.path === '/repo-feature')).toMatchObject({
      prunable: true
    })
    // Locks shield missing registrations; repo-level handling covers the main worktree.
    expect(worktrees.find((worktree) => worktree.path === '/repo-locked')?.prunable).toBeUndefined()
    expect(worktrees.find((worktree) => worktree.path === '/repo')?.prunable).toBeUndefined()
  })
})
