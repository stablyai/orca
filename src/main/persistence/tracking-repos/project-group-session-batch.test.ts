import { describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { createProjectGroup } from '../../../shared/project-groups'
import { ProjectGroupUpdate } from '../../../shared/rpc-contract/repo-params'
import type { FolderWorkspace } from '../../../shared/folder-workspaces/folder-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { ProjectGroupUpdateArgs } from '../../ipc/repos/repo-ipc-arg-schemas'
import { createMinimalPersistedTerminalTab } from '../restoring-sessions/session-owner-fields'
import { ProjectGroupPersistenceOperations } from './project-group-operations'

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

    // Move 'other' inside 'child' (valid depth-2 reparenting)
    const nested = setup.operations.updateProjectGroup('other', {
      parentGroupId: 'child',
      tabOrder: 5
    })
    expect(nested?.parentGroupId).toBe('child')
    expect(nested?.tabOrder).toBe(5)

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
})
