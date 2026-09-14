import { describe, expect, it, vi } from 'vitest'
import type { RuntimeSkillCommandHost } from './runtime-skill-command-contract'
import { createSkillInstallAuthority } from './runtime-skill-install-authority'

const WORKTREE_ID = 'repo-1::/workspace/app'

function createHost(overrides: Partial<RuntimeSkillCommandHost> = {}): RuntimeSkillCommandHost {
  return {
    getRuntimeId: () => 'runtime-1',
    getUserDataPath: () => '/tmp/orca-skill-authority-test',
    isPackaged: () => true,
    getSettings: () => ({}),
    listRepos: () => [{ id: 'repo-1', path: '/workspace/app' }],
    listFolderWorkspaces: () => [],
    listResolvedWorktrees: async () => [],
    showManagedWorktree: async () => ({ id: WORKTREE_ID, path: '/workspace/app' }),
    getSshProvider: () => ({ requestHostRpc: vi.fn() }) as never,
    skillTransactionRecovery: Promise.resolve(),
    ...overrides
  } as RuntimeSkillCommandHost
}

describe('createSkillInstallAuthority', () => {
  // Why: collapsing a thrown lookup into null reports a transient git/IO failure as a missing
  // workspace, which is unactionable — the real cause never reaches the caller or the logs.
  it('surfaces a worktree lookup failure instead of reporting it as not found', async () => {
    const authority = createSkillInstallAuthority(
      createHost({
        showManagedWorktree: async () => {
          throw new Error('git-index-locked')
        }
      })
    )

    await expect(authority.resolveWorktree(WORKTREE_ID)).rejects.toThrow('git-index-locked')
  })

  it('returns null when the lookup resolves a different worktree', async () => {
    const authority = createSkillInstallAuthority(
      createHost({ showManagedWorktree: async () => ({ id: 'repo-1::/other', path: '/other' }) })
    )

    await expect(authority.resolveWorktree(WORKTREE_ID)).resolves.toBeNull()
  })
})
