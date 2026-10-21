import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { RuntimeGitCommands } from './orca-runtime-git'
import type { ResolvedRuntimeGitWorktree } from './runtime-git-command-target'

const getBranchDiffMock = vi.hoisted(() => vi.fn())

vi.mock('../git/status', () => ({ getBranchDiff: getBranchDiffMock }))

function makeWorktree(path: string): ResolvedRuntimeGitWorktree {
  const worktree = {
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
  } satisfies Partial<ResolvedRuntimeGitWorktree>
  return worktree as unknown as ResolvedRuntimeGitWorktree
}

describe('RuntimeGitCommands branch diff', () => {
  beforeEach(() => {
    getBranchDiffMock.mockReset()
  })

  it('forwards the pinned head through normalized nested paths', async () => {
    const mergeBase = 'a'.repeat(40)
    const headOid = 'b'.repeat(40)
    const result = {
      kind: 'text',
      originalContent: 'left',
      modifiedContent: 'right',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    getBranchDiffMock.mockResolvedValue(result)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/repo'),
        executionHostId: 'local'
      }),
      getRuntimeSettings: () => ({}) as GlobalSettings
    })

    await expect(
      commands.getRuntimeGitBranchDiff(
        'id:wt-1',
        { mergeBase, headOid },
        'src\\file.ts',
        'src\\old-file.ts'
      )
    ).resolves.toEqual(result)

    expect(getBranchDiffMock).toHaveBeenCalledWith(
      '/repo',
      { mergeBase, headOid, filePath: 'src/file.ts', oldPath: 'src/old-file.ts' },
      { admissionTier: 'interactive' }
    )
  })
})
