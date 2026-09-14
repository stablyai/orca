import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { RuntimeGitCommands, type ResolvedRuntimeGitWorktree } from './orca-runtime-git'

const getSshGitProviderMock = vi.hoisted(() => vi.fn())

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

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
    getSshGitProviderMock.mockReset()
  })

  it('forwards the pinned head through normalized nested SSH paths', async () => {
    const mergeBase = 'a'.repeat(40)
    const headOid = 'b'.repeat(40)
    const result = {
      kind: 'text',
      originalContent: 'left',
      modifiedContent: 'right',
      originalIsBinary: false,
      modifiedIsBinary: false
    }
    const provider = { getBranchDiff: vi.fn().mockResolvedValue([result]) }
    getSshGitProviderMock.mockReturnValue(provider)
    const commands = new RuntimeGitCommands({
      resolveRuntimeGitTarget: async () => ({
        worktree: makeWorktree('/remote/repo'),
        executionHostId: 'ssh:conn-1'
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

    expect(provider.getBranchDiff).toHaveBeenCalledWith('/remote/repo', mergeBase, {
      includePatch: true,
      headOid,
      filePath: 'src/file.ts',
      oldPath: 'src/old-file.ts'
    })
  })
})
