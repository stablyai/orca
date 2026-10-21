import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import { createProjectGroup } from '../../../shared/project-groups'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
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
  const removeWorkspaceLineageForFolderParent = vi.fn()
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
    removeWorkspaceLineageForFolderParent,
    pruneMobileClientTabSelections
  })
  return {
    state,
    removedIds,
    selected,
    operations,
    scheduleSave,
    removeWorkspaceLineageForFolderParent,
    pruneMobileClientTabSelections
  }
}

afterEach(() => vi.restoreAllMocks())

describe('project group session removal', () => {
  it('copies each host session once when deleting many folder workspaces', () => {
    const { operations } = fixture(24)
    const clone = vi.spyOn(globalThis, 'structuredClone')
    expect(operations.deleteProjectGroup('root')).toBe(true)
    expect(clone).toHaveBeenCalledTimes(3)
  })

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
    expect(setup.removeWorkspaceLineageForFolderParent.mock.calls).toEqual(
      setup.removedIds.map((id) => [id])
    )
    expect(setup.pruneMobileClientTabSelections).toHaveBeenCalledTimes(1)
    expect(setup.scheduleSave).toHaveBeenCalledTimes(1)
  })

  it('preserves session references when the deleted group has no folder workspaces', () => {
    const { state, operations, scheduleSave } = fixture(0)
    const local = state.workspaceSession
    const hosts = state.workspaceSessionsByHostId
    const clone = vi.spyOn(globalThis, 'structuredClone')
    expect(operations.deleteProjectGroup('root')).toBe(true)
    expect(state.workspaceSession).toBe(local)
    expect(state.workspaceSessionsByHostId).toBe(hosts)
    expect(clone).not.toHaveBeenCalled()
    expect(scheduleSave).toHaveBeenCalledTimes(1)
  })

  it('does not prune or save when the requested group does not exist', () => {
    const setup = fixture(8)
    const before = structuredClone(setup.state)
    expect(setup.operations.deleteProjectGroup('missing')).toBe(false)
    expect(setup.state).toEqual(before)
    expect(setup.removeWorkspaceLineageForFolderParent).not.toHaveBeenCalled()
    expect(setup.pruneMobileClientTabSelections).not.toHaveBeenCalled()
    expect(setup.scheduleSave).not.toHaveBeenCalled()
  })
})
