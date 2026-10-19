import { describe, expect, it, vi } from 'vitest'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import type { ResolvedWorktree } from './runtime-worktree-path-identity'
import type { RuntimeStore } from './runtime-store-contract'
import type { Worktree } from '../../shared/worktree/types'

vi.mock('../../shared/sidebar-inputs-switch', () => ({ ORCA_SIDEBAR_INPUTS_IS_MAIN: true }))

describe('buildRuntimeWorktreePsSummaries with sort stamps', () => {
  it('tells clients the host sorts by its stamps, and carries the tier', () => {
    const row = (id: string, stamps: Pick<Worktree, 'smartTier' | 'smartAt'>): ResolvedWorktree => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these worktree fields.
      const worktree = {
        id,
        repoId: 'repo-1',
        path: id.split('::')[1],
        branch: 'feature',
        isArchived: false,
        isMainWorktree: false,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        lastActivityAt: 7,
        ...stamps
      } as unknown as ResolvedWorktree
      return worktree
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these store methods.
    const store = {
      getRepos: () => [],
      getWorktreeMeta: () => undefined,
      getAllWorktreeMeta: () => ({}),
      getFolderWorkspaces: () => [],
      getProjectGroups: () => []
    } as unknown as RuntimeStore
    const summaries = buildRuntimeWorktreePsSummaries({
      store,
      resolvedWorktrees: [
        row('repo-1::/w/done', { smartTier: 'done', smartAt: 5 }),
        row('repo-1::/w/rest', {})
      ],
      platformByRepoId: new Map()
    })
    expect(summaries.get('repo-1::/w/done')).toMatchObject({
      lastActivityAt: 7,
      sortedByStamps: true,
      smartTier: 'done',
      smartAt: 5
    })
    expect(summaries.get('repo-1::/w/rest')).toMatchObject({ sortedByStamps: true })
    expect(summaries.get('repo-1::/w/rest')).not.toHaveProperty('smartTier')
  })
})
