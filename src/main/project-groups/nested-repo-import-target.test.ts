import { describe, expect, it, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import type { GitWorktreeInfo } from '../../shared/types'
import { listWorktreeGraph } from '../git/worktree'
import {
  createNestedRepoImportTargetResolver,
  resolveLocalNestedRepoImportTargetPath,
  resolveSshNestedRepoImportTargetPath
} from './nested-repo-import-target'

vi.mock('../git/worktree', () => ({
  listWorktreeGraph: vi.fn()
}))

function worktree(overrides: Partial<GitWorktreeInfo>): GitWorktreeInfo {
  return {
    path: join('/workspace', 'repo'),
    head: 'abc',
    branch: 'refs/heads/main',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

describe('nested repo import target resolution', () => {
  beforeEach(() => {
    vi.mocked(listWorktreeGraph).mockReset()
  })

  it('canonicalizes a selected linked worktree to its non-bare main worktree', async () => {
    const mainPath = join('/workspace', 'source', 'demo')
    const selectedPath = `${join('/workspace', 'paseo', 'demo', 'brash-binder')}/`
    const selectedPathInGraph = join('/workspace', 'paseo', 'demo', 'brash-binder')
    vi.mocked(listWorktreeGraph).mockResolvedValue([
      worktree({ path: mainPath, isMainWorktree: true }),
      worktree({ path: selectedPathInGraph, branch: 'refs/heads/brash-binder' })
    ])

    await expect(resolveLocalNestedRepoImportTargetPath(selectedPath)).resolves.toBe(mainPath)
    expect(listWorktreeGraph).toHaveBeenCalledWith(selectedPath)
  })

  it('warms the local resolver cache for sibling worktrees in the same graph', async () => {
    const mainPath = join('/workspace', 'source', 'demo')
    const firstPath = join('/workspace', 'paseo', 'demo', 'brash-binder')
    const secondPath = join('/workspace', 'paseo', 'demo', 'quick-howler')
    vi.mocked(listWorktreeGraph).mockResolvedValue([
      worktree({ path: mainPath, isMainWorktree: true }),
      worktree({ path: firstPath, branch: 'refs/heads/brash-binder' }),
      worktree({ path: secondPath, branch: 'refs/heads/quick-howler' })
    ])
    const resolver = createNestedRepoImportTargetResolver()

    await expect(resolver.resolveLocal(firstPath)).resolves.toBe(mainPath)
    await expect(resolver.resolveLocal(secondPath)).resolves.toBe(mainPath)
    expect(listWorktreeGraph).toHaveBeenCalledTimes(1)
  })

  it('falls back when the worktree list is empty', async () => {
    const selectedPath = join('/workspace', 'paseo', 'demo', 'brash-binder')
    vi.mocked(listWorktreeGraph).mockResolvedValue([])

    await expect(resolveLocalNestedRepoImportTargetPath(selectedPath)).resolves.toBe(selectedPath)
  })

  it('falls back when the worktree lister throws', async () => {
    const selectedPath = join('/workspace', 'paseo', 'demo', 'brash-binder')
    vi.mocked(listWorktreeGraph).mockRejectedValue(new Error('git failed'))

    await expect(resolveLocalNestedRepoImportTargetPath(selectedPath)).resolves.toBe(selectedPath)
  })

  it('falls back when Git returns a stale graph that omits the selected path', async () => {
    const selectedPath = join('/workspace', 'paseo', 'demo', 'brash-binder')
    vi.mocked(listWorktreeGraph).mockResolvedValue([
      worktree({ path: join('/other', 'source', 'demo'), isMainWorktree: true }),
      worktree({ path: join('/other', 'linked', 'quick-howler') })
    ])

    await expect(resolveLocalNestedRepoImportTargetPath(selectedPath)).resolves.toBe(selectedPath)
  })

  it('falls back when the only main worktree is bare', async () => {
    const selectedPath = join('/workspace', 'paseo', 'demo', 'brash-binder')
    vi.mocked(listWorktreeGraph).mockResolvedValue([
      worktree({
        path: join('/workspace', 'source', 'demo.git'),
        isBare: true,
        isMainWorktree: true
      }),
      worktree({ path: selectedPath, branch: 'refs/heads/brash-binder' })
    ])

    await expect(resolveLocalNestedRepoImportTargetPath(selectedPath)).resolves.toBe(selectedPath)
  })

  it('uses the SSH provider worktree list for remote import targets', async () => {
    const mainPath = join('/srv', 'source', 'demo')
    const selectedPath = join('/srv', 'paseo', 'demo', 'brash-binder')
    const gitProvider = {
      listWorktrees: vi
        .fn()
        .mockResolvedValue([
          worktree({ path: mainPath, isMainWorktree: true }),
          worktree({ path: selectedPath, branch: 'refs/heads/brash-binder' })
        ])
    }

    await expect(resolveSshNestedRepoImportTargetPath(selectedPath, gitProvider)).resolves.toBe(
      mainPath
    )
    expect(gitProvider.listWorktrees).toHaveBeenCalledWith(selectedPath)
    expect(listWorktreeGraph).not.toHaveBeenCalled()
  })
})
