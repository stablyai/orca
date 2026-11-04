import { describe, expect, it } from 'vitest'
import {
  applyMobileWorkspaceLineage,
  getMobileWorkspaceLineageChildren,
  getMobileWorkspaceLineageGroupKey
} from './mobile-workspace-lineage'
import {
  buildSections,
  buildMobileWorkspacePlan,
  NO_PROJECT_SECTION_CATALOG,
  type Worktree
} from './workspace-list-sections'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'worktree',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'worktree',
    path: '/tmp/worktree',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('applyMobileWorkspaceLineage', () => {
  it.each([false, true])(
    'keeps deep project identity in each occurrence (duplicate pins: %s)',
    (duplicate) => {
      const parent = worktree({ worktreeId: 'parent', isPinned: true })
      const child = worktree({
        worktreeId: 'child',
        repoId: 'repo-2',
        repo: 'Backend',
        parentWorktreeId: parent.worktreeId
      })
      const grandchild = { ...child, worktreeId: 'grandchild', parentWorktreeId: child.worktreeId }
      const filters = {
        hideSleepingWorkspaces: false,
        alwaysShowDefaultBranchWorkspace: true,
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        filterRepoIds: [],
        visibleHostIds: null
      }
      const plan = buildMobileWorkspacePlan(
        [grandchild, child, parent],
        'name',
        filters,
        '',
        'repo',
        new Set(),
        NO_PROJECT_SECTION_CATALOG,
        undefined,
        undefined,
        duplicate
      )
      const collapsed = new Set([getMobileWorkspaceLineageGroupKey(parent)])
      expect(
        plan
          .render(collapsed)
          .flatMap((section) => section.data)
          .map((item) => item.row.worktreeId)
      ).toEqual(duplicate ? ['parent', 'parent'] : ['parent'])
      expect(plan.render(collapsed)[0]?.data[0]?.view).toMatchObject({
        lineageChildCount: 1,
        lineageCollapsed: true
      })
      const sections = plan.render(new Set())
      expect(sections).toHaveLength(duplicate ? 2 : 1)
      for (const section of sections) {
        expect(section.data.map((item) => item.row.worktreeId)).toEqual([
          'parent',
          'child',
          'grandchild'
        ])
        expect(section.data.map((item) => item.view.lineageDepth)).toEqual([0, 1, 2])
        expect(section.data.map((item) => item.view.showProjectName)).toEqual([false, true, false])
      }
      const keys = sections.flatMap((section) =>
        section.data.map((item) => item.view.sectionListKey)
      )
      expect(new Set(keys).size).toBe(keys.length)
      const filtered = buildSections(
        [parent, child, { ...grandchild, repoId: 'repo-3' }],
        'name',
        { ...filters, filterRepoIds: ['repo-1', 'repo-3'] },
        '',
        'repo',
        new Set()
      )
      expect(
        filtered.map((section) => [
          section.key,
          section.data.map((item) => [item.row.worktreeId, item.view.lineageDepth])
        ])
      ).toEqual([
        ['pinned', [['parent', 0]]],
        ['repo:repo-3', [['grandchild', 0]]]
      ])
    }
  )

  it('does not nest stale lineage when instance ids no longer match', () => {
    const parent = worktree({ worktreeId: 'parent', worktreeInstanceId: 'new-parent-instance' })
    const child = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent',
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'old-parent-instance'
    })

    const rows = applyMobileWorkspaceLineage([child, parent])

    expect(rows.map((item) => item.row.worktreeId)).toEqual(['child', 'parent'])
    expect(rows.map((item) => item.view.lineageDepth)).toEqual([0, 0])
  })

  it('keeps rows visible when lineage is cyclic', () => {
    const first = worktree({ worktreeId: 'first', parentWorktreeId: 'second' })
    const second = worktree({ worktreeId: 'second', parentWorktreeId: 'first' })

    const rows = applyMobileWorkspaceLineage([first, second])

    expect(rows.map((item) => item.row.worktreeId).sort()).toEqual(['first', 'second'])
  })

  it('keeps same-id rows on different hosts visible', () => {
    const local = worktree({ worktreeId: 'shared', hostId: 'local' })
    const remote = worktree({ worktreeId: 'shared', hostId: 'ssh:builder' })

    const rows = applyMobileWorkspaceLineage([local, remote])

    expect(rows.map((item) => item.row.hostId)).toEqual(['local', 'ssh:builder'])
  })
})

describe('getMobileWorkspaceLineageChildren across machines', () => {
  const parent = worktree({ worktreeId: 'mac::/src/fix', worktreeInstanceId: 'parent-instance' })
  const child = worktree({
    worktreeId: 'srv::/work/fix-tests',
    hostId: 'runtime:env-1',
    worktreeInstanceId: 'child-instance',
    crossStoreParent: {
      childWorkspaceKey: 'worktree:srv::/work/fix-tests',
      childInstanceId: 'child-instance',
      parent: {
        installationId: 'mac-install',
        workspaceKey: 'worktree:mac::/src/fix',
        instanceId: 'parent-instance'
      },
      origin: 'manual',
      capture: { source: 'manual-action', confidence: 'explicit' },
      createdAt: 1
    }
  })
  const server = { hostId: 'runtime:env-1' as const, installationId: 'srv-install' }

  it("nests a relayed server row under the desktop's own parent", () => {
    const children = getMobileWorkspaceLineageChildren([parent, child], {
      ownInstallationId: 'mac-install',
      servers: [server]
    })
    expect([...children].map(([key, rows]) => [key, rows.map((row) => row.worktreeId)])).toEqual([
      ['|mac::/src/fix', ['srv::/work/fix-tests']]
    ])
  })
})
