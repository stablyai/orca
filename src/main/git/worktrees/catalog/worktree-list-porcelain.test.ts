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

vi.mock('../../command-runner/host-routing/wsl-path-translation', async (importOriginal) => ({
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
