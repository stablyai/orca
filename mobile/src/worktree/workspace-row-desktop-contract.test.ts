import { describe, expect, it } from 'vitest'
import { NO_WORKSPACE_ROW_FILTERS } from '@orca/test-host/shared/workspace-view/workspace-row-filters'
import { buildRuntimeWorktreePsSummaries } from '@orca/test-host/main/runtime/runtime-worktree-ps-summaries'
import type { RuntimeStore } from '@orca/test-host/main/runtime/runtime-store-contract'
import type { ResolvedWorktree } from '@orca/test-host/main/runtime/runtime-worktree-path-identity'
import { buildPreFeedSections } from '@orca/test-mobile/host-screen/host-sidebar-feed-sections'
import { buildSections } from '@orca/test-mobile/worktree/workspace-list-sections'
import { admitWorktreeCatalogResponse } from '@orca/test-mobile/worktree/worktree-catalog-snapshot-client'
import { buildWorktreeHostContextOf } from '@orca/test-mobile/worktree/worktree-host-context-labels'
import { INITIAL_MOBILE_VIEW } from '@orca/test-mobile/worktree/workspace-view-settings'

const PARENT_ID = 'repo-1::/work/app'
const CHILD_ID = 'repo-1::/work/app-child'

function resolvedWorktree(fields: Partial<ResolvedWorktree>): ResolvedWorktree {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these worktree fields.
  return {
    repoId: 'repo-1',
    isArchived: false,
    isMainWorktree: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    lineage: null,
    lastActivityAt: 0,
    ...fields
  } as ResolvedWorktree
}

// The desktop's own worktree.ps rows: a parent on this machine and its child on an SSH host.
function desktopRows() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the summary builder reads only these store methods.
  const store = {
    getRepos: () => [],
    getWorktreeMeta: (id: string) => (id === CHILD_ID ? { hostId: 'ssh:box' } : undefined),
    getAllWorktreeMeta: () => ({}),
    getFolderWorkspaces: () => [],
    getProjectGroups: () => []
  } as unknown as RuntimeStore
  const summaries = buildRuntimeWorktreePsSummaries({
    store,
    resolvedWorktrees: [
      resolvedWorktree({
        id: PARENT_ID,
        path: '/work/app',
        branch: 'main',
        displayName: 'app',
        isMainWorktree: true,
        childWorktreeIds: [CHILD_ID]
      }),
      resolvedWorktree({
        id: CHILD_ID,
        path: '/work/app-child',
        branch: 'feature',
        displayName: 'app child',
        parentWorktreeId: PARENT_ID
      })
    ],
    platformByRepoId: new Map()
  })
  return [...summaries.values()]
}

describe('desktop worktree.ps rows through the phone list', () => {
  it('lists the desktop rows unchanged and keeps the phone facts beside them', () => {
    const rows = desktopRows()
    const admitted = admitWorktreeCatalogResponse({ worktrees: rows, snapshotId: 's1' }, null)
    expect(admitted.kind).toBe('full')
    const worktrees = admitted.kind === 'full' ? admitted.worktrees : []
    const hostContextOf = buildWorktreeHostContextOf(worktrees, {
      repoHostIdByRepoId: new Map(),
      hostLabelById: new Map([['ssh:box', 'box']]),
      hostPlatform: 'darwin',
      hostHealthById: new Map()
    })

    const items = buildSections(
      worktrees,
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'none',
      new Set()
    ).flatMap((section) => section.data)
    // The SSH child keys its parent by the parent's own host, so it lists as a root here.
    expect(items.map((item) => item.row)).toEqual(expect.arrayContaining(rows))
    expect(items).toHaveLength(rows.length)

    const listed = buildPreFeedSections({
      rows: worktrees,
      hostContextOf,
      view: INITIAL_MOBILE_VIEW,
      search: '',
      repoHostIdByRepoId: new Map(),
      lastVisited: null
    }).flatMap((section) => section.data)
    expect(listed.map((item) => item.row.worktreeId)).toEqual(rows.map((row) => row.worktreeId))
    for (const item of listed) {
      const desktopRow = rows.find((row) => row.worktreeId === item.row.worktreeId)
      // Only the phone's own highlight replaces a desktop value; no phone key is added to the row.
      expect(item.row).toEqual({ ...desktopRow, isActive: false })
    }
    expect(listed.map((item) => item.view.hostContextLabel)).toEqual(['Local Mac', 'box'])
  })

  it('nests a same-host child under its parent through the phone lineage', () => {
    const rows = desktopRows().map((row) => ({ ...row, hostId: undefined }))
    const items = buildSections(
      rows,
      'name',
      { ...NO_WORKSPACE_ROW_FILTERS },
      '',
      'none',
      new Set()
    ).flatMap((section) => section.data)
    expect(items.map((item) => [item.row.worktreeId, item.view.lineageDepth])).toEqual([
      [PARENT_ID, 0],
      [CHILD_ID, 1]
    ])
    expect(items[0].view.lineageChildCount).toBe(1)
    for (const item of items) {
      expect(Object.keys(item.row)).not.toContain('lineageDepth')
    }
  })
})
