import { describe, expect, it } from 'vitest'
import { buildRuntimeWorktreePsSummaries } from './runtime-worktree-ps-summaries'
import { runtimeWorktreePsRowKey } from './runtime-worktree-summary-paths'
import type { ResolvedWorktree } from '../catalog/runtime-worktree-path-identity'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import { storeFolderWorkspace } from '../../construction/test-context/runtime-store-partial-fixture'

describe('buildRuntimeWorktreePsSummaries', () => {
  describe('the bot a workspace is under', () => {
    const lineage = {
      worktreeId: 'child',
      worktreeInstanceId: 'child-instance',
      parentWorktreeId: 'parent',
      parentWorktreeInstanceId: 'parent-instance',
      origin: 'cli',
      capture: { source: 'env-workspace', confidence: 'explicit' },
      createdAt: 1
    }
    const botOf = (withWorktreeParent: boolean) => {
      const rows = ['parent', 'child'].map((id) => ({
        id,
        repoId: 'r',
        path: `/repo/${id}`,
        branch: id,
        isArchived: false,
        isMainWorktree: false,
        lastActivityAt: 0,
        hostId: 'local',
        instanceId: `${id}-instance`,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: id === 'child' && withWorktreeParent ? lineage : null
      }))
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these store methods.
      const store = {
        getRepos: () => [],
        getAllWorktreeMeta: () => ({}),
        getFolderWorkspaces: () => [
          storeFolderWorkspace({ id: 'bot-home', projectGroupId: 'g', folderPath: '/bot' })
        ],
        getProjectGroups: () => [],
        getBots: () => [{ folderWorkspaceId: 'bot-home', name: 'Atlas' }],
        getAllWorkspaceLineage: () => ({
          'worktree:child': {
            childWorkspaceKey: 'worktree:child',
            childInstanceId: 'child-instance',
            parentWorkspaceKey: 'folder:bot-home',
            origin: 'cli',
            capture: { source: 'env-workspace', confidence: 'explicit' },
            createdAt: 1
          }
        })
      } as unknown as RuntimeStore
      return buildRuntimeWorktreePsSummaries({
        store,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these worktree fields.
        resolvedWorktrees: rows as unknown as ResolvedWorktree[],
        platformByRepoId: new Map()
      }).get(runtimeWorktreePsRowKey({ worktreeId: 'child', hostId: 'local' }))?.bot
    }

    it("names the bot for any link to its home, but not when the sidebar's worktree parent wins", () => {
      expect(botOf(false)).toBe('Atlas')
      expect(botOf(true)).toBeUndefined()
    })
  })
})
