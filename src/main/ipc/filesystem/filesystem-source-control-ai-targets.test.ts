import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Store } from '../../persistence'
import type { Repo } from '../../../shared/repo-types'

const mocks = vi.hoisted(() => ({ graph: vi.fn(), gitOptions: vi.fn() }))
vi.mock('../../repo-worktrees', () => ({ listRepoWorktreeGraph: mocks.graph }))
vi.mock('../../project-runtime-git-options', () => ({
  getLocalProjectWorktreeGitOptions: mocks.gitOptions
}))
vi.mock('../registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: async (path: string) => path
}))
vi.mock('../filesystem-auth', () => ({ resolveAuthorizedPath: vi.fn() }))
vi.mock('../../providers/ssh-git-dispatch', () => ({ getSshGitProvider: vi.fn() }))
import { getRepoForSourceControlAi } from './filesystem-source-control-ai-targets'

const repo: Repo = {
  id: 'wsl-drive-repo',
  path: resolve('/wsl-drive/repo'),
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0
}
const worktree = resolve('/wsl-drive/workspaces/feature-extra')

function fixture(): Store {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the ownership check reads only these store methods.
  return { getRepo: () => repo, getAllWorktreeMeta: () => ({}) } as unknown as Store
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.gitOptions.mockReturnValue({ wslDistro: 'Ubuntu-24.04' })
  // Only WSL Git names the checkout the way the renderer does; host Git reads its `/mnt/c` metadata.
  mocks.graph.mockImplementation(async (_repo: Repo, options?: { wslDistro?: string }) => [
    { path: options?.wslDistro ? worktree : resolve('/mnt/c/wsl-drive/workspaces/feature-extra') }
  ])
})

describe('source control AI repo ownership for a detected worktree', () => {
  it('lists through the project runtime, so a WSL-runtime drive worktree keeps its repo', async () => {
    await expect(
      getRepoForSourceControlAi(fixture(), { repoId: repo.id, worktreePath: worktree })
    ).resolves.toBe(repo)
    expect(mocks.graph).toHaveBeenCalledWith(repo, { wslDistro: 'Ubuntu-24.04' })
  })

  it('does not claim a worktree the repo listing does not name', async () => {
    await expect(
      getRepoForSourceControlAi(fixture(), {
        repoId: repo.id,
        worktreePath: resolve('/wsl-drive/elsewhere')
      })
    ).resolves.toBeNull()
  })
})
