import { describe, expect, it, vi } from 'vitest'
import * as z from 'zod'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  clearMissingProjectGroupMemberships,
  createProjectGroup,
  normalizeProjectGroups
} from '../../../shared/project-groups'
import { buildMobileProjectSectionCatalog } from '../../../shared/mobile-project-sections-contract'
import { ProjectSectionCatalogSchema } from '../../../shared/project-section-catalog-schema'
import { buildSidebarFeedCatalog } from '../../../shared/sidebar-list/sidebar-feed-catalog'
import { ProjectGroupUpdate } from '../../../shared/rpc-contract/repo-params'
import { createRepoUpdateSchema } from '../../../shared/rpc-contract/repo-update-params'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { ProjectGroupUpdateArgs } from '../../ipc/repos/repo-ipc-arg-schemas'
import { FolderWorkspacePersistenceOperations } from '../restoring-sessions/folder-workspace-operations'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { ProjectGroupPersistenceOperations } from './project-group-operations'
import { RepoUpdatePersistenceOperations } from './repo-update-operations'

function workspace(id: string, projectGroupId: string): FolderWorkspace {
  return {
    id,
    projectGroupId,
    name: id,
    folderPath: '/workspace',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function session(owners: string[]): WorkspaceSessionState {
  const result = getDefaultWorkspaceSession()
  result.activeWorkspaceKey = folderWorkspaceKey(owners[0])
  result.activeWorktreeId = folderWorkspaceKey(owners[0])
  result.activeWorktreeIdsOnShutdown = owners.map(folderWorkspaceKey)
  result.lastVisitedAtByWorktreeId = {}
  result.defaultTerminalTabsAppliedByWorktreeId = {}
  result.terminalPtyIncarnationsByPaneKey = {}
  result.terminalTopologyRevisionByRepoId = { unrelated: 7 }
  for (const id of owners) {
    const owner = folderWorkspaceKey(id)
    result.tabsByWorktree[owner] = [
      {
        ...createMinimalPersistedTerminalTab({
          worktreeId: owner,
          tabId: id,
          ptyId: `pty-${id}`,
          existingTabCount: 0
        }),
        createdAt: 0
      }
    ]
    result.terminalLayoutsByTabId[id] = {
      root: { type: 'leaf', leafId: `leaf-${id}` },
      activeLeafId: `leaf-${id}`,
      expandedLeafId: null,
      buffersByLeafId: { [`leaf-${id}`]: 'scrollback'.repeat(1024) }
    }
    result.lastVisitedAtByWorktreeId[`ssh:builder|${owner}`] = 1
    result.defaultTerminalTabsAppliedByWorktreeId[owner] = true
    result.terminalPtyIncarnationsByPaneKey[`${id}:leaf-${id}`] = `incarnation-${id}`
  }
  return result
}

function fixture(folderCount: number) {
  const state = getDefaultPersistedState('/home/test')
  state.projectGroups = [
    { ...createProjectGroup({ name: 'Root', createdFrom: 'manual', tabOrder: 0 }), id: 'root' },
    {
      ...createProjectGroup({ name: 'Child', createdFrom: 'manual', tabOrder: 1 }),
      id: 'child',
      parentGroupId: 'root'
    },
    { ...createProjectGroup({ name: 'Other', createdFrom: 'manual', tabOrder: 2 }), id: 'other' }
  ]
  const removedIds = Array.from({ length: folderCount }, (_, index) => `removed-${index}`)
  state.folderWorkspaces = [
    ...removedIds.map((id, index) => workspace(id, index % 2 ? 'child' : 'root')),
    workspace('kept', 'other')
  ]
  state.workspaceSession = session([...removedIds, 'kept'])
  state.workspaceSessionsByHostId = {
    'ssh:builder': session([...removedIds, 'kept']),
    'runtime:remote': session([...removedIds, 'kept'])
  }
  const scheduleSave = vi.fn()
  const removeWorkspaceLineageForRemovedFolder = vi.fn()
  const selected = new Set([...removedIds, 'kept'].map(folderWorkspaceKey))
  const pruneMobileClientTabSelections = vi.fn((matches: (owner: string) => boolean) => {
    for (const owner of selected) {
      if (matches(owner)) {
        selected.delete(owner)
      }
    }
  })
  const operations = new ProjectGroupPersistenceOperations({
    state,
    scheduleSave,
    removeWorkspaceLineageForRemovedFolder,
    pruneMobileClientTabSelections
  })
  return {
    state,
    removedIds,
    selected,
    operations
  }
}

describe('project group session removal', () => {
  it('removes the entire subtree from local spill and remote sessions while preserving other owners', () => {
    const setup = fixture(8)
    const kept = session(['kept'])
    kept.activeWorkspaceKey = null
    kept.activeWorktreeId = null
    expect(setup.operations.deleteProjectGroup('root')).toBe(true)
    expect(setup.state.workspaceSession).toEqual(kept)
    expect(setup.state.workspaceSessionsByHostId).toEqual({
      'ssh:builder': kept,
      'runtime:remote': kept
    })
    expect(setup.state.projectGroups?.map((group) => group.id)).toEqual(['other'])
    expect(setup.state.folderWorkspaces.map((entry) => entry.id)).toEqual(['kept'])
    expect(setup.selected).toEqual(new Set([folderWorkspaceKey('kept')]))
  })

  it('reparents groups cleanly and refuses self-parenting, descendant cycles, or missing parents', () => {
    const setup = fixture(0)
    setup.state.projectGroups!.find((group) => group.id === 'other')!.rootProjectOrder = 2000

    // Move 'other' inside 'child' (valid depth-2 reparenting) and clear stale rootProjectOrder
    const nested = setup.operations.updateProjectGroup('other', {
      parentGroupId: 'child',
      tabOrder: 5
    })
    expect(nested?.parentGroupId).toBe('child')
    expect(nested?.tabOrder).toBe(5)
    expect(nested?.rootProjectOrder).toBeUndefined()

    // Refuse moving 'root' inside itself or inside its descendant 'other' without mutating tabOrder
    expect(
      setup.operations.updateProjectGroup('root', { parentGroupId: 'root', tabOrder: 99 })
    ).toBeNull()
    expect(
      setup.operations.updateProjectGroup('root', { parentGroupId: 'other', tabOrder: 99 })
    ).toBeNull()
    expect(
      setup.operations.updateProjectGroup('root', { parentGroupId: 'missing-id', tabOrder: 99 })
    ).toBeNull()
    expect(setup.state.projectGroups?.find((group) => group.id === 'root')?.tabOrder).toBe(0)

    // Move 'other' back to root (parentGroupId: null)
    const promoted = setup.operations.updateProjectGroup('other', {
      parentGroupId: null,
      tabOrder: 3
    })
    expect(promoted?.parentGroupId).toBeNull()
    expect(promoted?.tabOrder).toBe(3)

    // Normalize empty string parentGroupId to null across persistence, IPC, and RPC schemas
    const promotedFromEmpty = setup.operations.updateProjectGroup('child', {
      parentGroupId: '   '
    })
    expect(promotedFromEmpty?.parentGroupId).toBeNull()
    expect(
      ProjectGroupUpdateArgs.parse({
        groupId: 'child',
        updates: { parentGroupId: '' }
      }).updates.parentGroupId
    ).toBe('')
    expect(
      ProjectGroupUpdate.parse({
        groupId: 'child',
        updates: { parentGroupId: '' }
      }).updates.parentGroupId
    ).toBeNull()
  })

  it('rejects subgroup creation when parentGroupId does not exist', () => {
    const setup = fixture(0)
    const beforeIds = setup.state.projectGroups?.map((group) => group.id)

    expect(() =>
      setup.operations.createProjectGroup({
        name: 'Orphan',
        parentGroupId: 'deleted-parent',
        createdFrom: 'manual'
      })
    ).toThrow('project_group_parent_not_found')
    expect(setup.state.projectGroups?.map((group) => group.id)).toEqual(beforeIds)
  })

  it('inherits SSH connectionId and executionHostId from parent group when creating a subgroup and rejects cross-host reparenting', () => {
    const setup = fixture(0)
    const sshParent = setup.operations.createProjectGroup({
      name: 'SSH Parent',
      connectionId: 'ssh-box-1',
      createdFrom: 'manual'
    })
    const subgroup = setup.operations.createProjectGroup({
      name: 'SSH Sub',
      connectionId: null,
      parentGroupId: sshParent.id,
      createdFrom: 'manual'
    })

    expect(subgroup.connectionId).toBe('ssh-box-1')
    expect(
      setup.operations.updateProjectGroup('root', { parentGroupId: sshParent.id, tabOrder: 5 })
    ).toBeNull()
    expect(
      setup.operations.updateProjectGroup(subgroup.id, { parentGroupId: 'root', tabOrder: 5 })
    ).toBeNull()
  })

  it('persists isPinned on groups and repos, preserves it on same-container reorder, and resets on container moves or group deletion', () => {
    const setup = fixture(0)
    setup.state.repos = [
      {
        id: 'repo-a',
        path: '/repo-a',
        displayName: 'Repo A',
        badgeColor: '#111111',
        addedAt: 1,
        projectGroupId: 'child',
        projectGroupOrder: 0
      }
    ]
    const repoUpdates = new RepoUpdatePersistenceOperations({
      state: setup.state,
      bumpLocalWorktreeScanGeneration: vi.fn(),
      syncProjectHostSetupCompatibilityState: vi.fn(),
      scheduleSave: vi.fn(),
      hydrateRepo: (repo) => repo
    })
    const folderOps = new FolderWorkspacePersistenceOperations({
      state: setup.state,
      scheduleSave: vi.fn(),
      removeWorkspaceLineageForRemovedFolder: vi.fn(),
      pruneMobileClientTabSelections: vi.fn(),
      hydrateRepo: (repo) => repo
    })

    // Pin subgroup 'child', reorder within same parent ('root') -> stays pinned
    expect(setup.operations.updateProjectGroup('child', { isPinned: true })?.isPinned).toBe(true)
    expect(setup.operations.updateProjectGroup('child', { tabOrder: 9 })?.isPinned).toBe(true)
    expect(
      setup.operations.updateProjectGroup('child', { parentGroupId: 'root', tabOrder: 2 })?.isPinned
    ).toBe(true)
    // Move subgroup 'child' to root -> auto-unpins
    expect(setup.operations.updateProjectGroup('child', { parentGroupId: null })?.isPinned).toBe(
      false
    )
    // Re-pin 'child' under 'root' for repo deletion test
    setup.operations.updateProjectGroup('child', { parentGroupId: 'root', isPinned: true })
    expect(
      normalizeProjectGroups(setup.state.projectGroups).find((group) => group.id === 'child')
        ?.isPinned
    ).toBe(true)

    // Pin 'repo-a' inside 'child', reorder within 'child' -> stays pinned
    expect(repoUpdates.updateRepo(setup.state.repos[0]!, { isPinned: true })?.isPinned).toBe(true)
    expect(folderOps.moveProjectToGroup(setup.state.repos[0]!, 'child', 4)?.isPinned).toBe(true)
    expect(
      repoUpdates.updateRepo(setup.state.repos[0]!, {
        projectGroupId: 'child',
        projectGroupOrder: 7
      })?.isPinned
    ).toBe(true)

    // Move 'repo-a' to 'other' -> auto-unpins
    expect(folderOps.moveProjectToGroup(setup.state.repos[0]!, 'other', 0)?.isPinned).toBe(false)

    // Re-pin 'repo-a' in 'other', then updateRepo projectGroupId to 'child' -> auto-unpins
    repoUpdates.updateRepo(setup.state.repos[0]!, { isPinned: true })
    expect(
      repoUpdates.updateRepo(setup.state.repos[0]!, { projectGroupId: 'child' })?.isPinned
    ).toBe(false)

    // Re-pin 'repo-a' in 'child', then delete 'root' subtree -> ungrouped repo is unpinned
    repoUpdates.updateRepo(setup.state.repos[0]!, { isPinned: true })
    expect(setup.operations.deleteProjectGroup('root')).toBe(true)
    expect(setup.state.repos[0]).toMatchObject({ projectGroupId: null, isPinned: false })

    // Missing group cleanup and IPC/RPC/mobile schemas preserve isPinned
    expect(
      clearMissingProjectGroupMemberships(
        [{ ...setup.state.repos[0]!, projectGroupId: 'gone', isPinned: true }],
        setup.state.projectGroups ?? []
      )[0]
    ).toMatchObject({ projectGroupId: null, isPinned: false })

    expect(
      ProjectGroupUpdateArgs.parse({ groupId: 'other', updates: { isPinned: true } }).updates
        .isPinned
    ).toBe(true)
    expect(
      ProjectGroupUpdate.parse({ groupId: 'other', updates: { isPinned: false } }).updates.isPinned
    ).toBe(false)
    const repoRpcSchema = createRepoUpdateSchema({ repo: z.string() })
    expect(
      repoRpcSchema.parse({ repo: 'repo-a', updates: { isPinned: true } }).updates.isPinned
    ).toBe(true)

    const mobileCatalog = buildMobileProjectSectionCatalog(
      [{ ...setup.state.repos[0]!, isPinned: true }],
      { projects: [], setups: [] },
      'manual',
      [{ ...setup.state.projectGroups![0]!, isPinned: true }]
    )
    const parsedServed = ProjectSectionCatalogSchema.parse(mobileCatalog)
    const feed = buildSidebarFeedCatalog(parsedServed, [], [])
    expect(feed.repos[0]?.isPinned).toBe(true)
    expect(feed.projectGroups[0]?.isPinned).toBe(true)
  })

  it('appends new subgroups and grouped projects after both existing projects and subgroups in that parent group', () => {
    const setup = fixture(0)
    setup.state.repos = [
      {
        id: 'repo-existing',
        path: '/repo-existing',
        displayName: 'Repo Existing',
        badgeColor: '#111111',
        addedAt: 1,
        projectGroupId: 'other',
        projectGroupOrder: 10
      },
      {
        id: 'repo-incoming',
        path: '/repo-incoming',
        displayName: 'Repo Incoming',
        badgeColor: '#222222',
        addedAt: 2,
        projectGroupId: null
      }
    ]
    const folderOps = new FolderWorkspacePersistenceOperations({
      state: setup.state,
      scheduleSave: vi.fn(),
      removeWorkspaceLineageForRemovedFolder: vi.fn(),
      pruneMobileClientTabSelections: vi.fn(),
      hydrateRepo: (repo) => repo
    })

    const createdSubgroup = setup.operations.createProjectGroup({
      name: 'Sub After Repo 10',
      parentGroupId: 'other',
      createdFrom: 'manual'
    })
    expect(createdSubgroup.tabOrder).toBe(11)

    const movedRepo = folderOps.moveProjectToGroup(setup.state.repos[1]!, 'other')
    expect(movedRepo?.projectGroupOrder).toBe(12)
  })

  it('appends new subgroups and moved projects after grouped sibling repos whose projectGroupOrder is undefined', () => {
    const setup = fixture(0)
    setup.state.repos = [
      {
        id: 'repo-incoming',
        path: '/repo-incoming',
        displayName: 'Repo Incoming',
        badgeColor: '#111111',
        addedAt: 1,
        projectGroupId: null
      },
      {
        id: 'repo-other',
        path: '/repo-other',
        displayName: 'Repo Other',
        badgeColor: '#222222',
        addedAt: 2,
        projectGroupId: null
      },
      {
        id: 'repo-fallback',
        path: '/repo-fallback',
        displayName: 'Repo Fallback',
        badgeColor: '#333333',
        addedAt: 3,
        projectGroupId: 'other'
      }
    ]
    const folderOps = new FolderWorkspacePersistenceOperations({
      state: setup.state,
      scheduleSave: vi.fn(),
      removeWorkspaceLineageForRemovedFolder: vi.fn(),
      pruneMobileClientTabSelections: vi.fn(),
      hydrateRepo: (repo) => repo
    })

    const createdSubgroup = setup.operations.createProjectGroup({
      name: 'Sub After Fallback Repo',
      parentGroupId: 'other',
      createdFrom: 'manual'
    })
    expect(createdSubgroup.tabOrder).toBe(2001)

    const movedRepo = folderOps.moveProjectToGroup(setup.state.repos[0]!, 'other')
    expect(movedRepo?.projectGroupOrder).toBe(2002)
  })
})
