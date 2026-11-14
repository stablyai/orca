import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { createProjectGroup } from '../../../shared/project-groups'
import { ProjectGroupPersistenceOperations } from './project-group-operations'

function fixture() {
  const state = getDefaultPersistedState('/workspace')
  state.projectGroups = ['a', 'b', 'other'].map((id, tabOrder) => ({
    ...createProjectGroup({ name: id, createdFrom: 'manual', tabOrder }),
    id
  }))
  const operations = new ProjectGroupPersistenceOperations({
    state,
    scheduleSave: () => {},
    removeWorkspaceLineageForRemovedFolder: () => {},
    pruneMobileClientTabSelections: () => {}
  })
  return { state, operations }
}

describe('batch project group updates', () => {
  it('updates and clears ranks for selected groups without changing unrelated groups', () => {
    const { state, operations } = fixture()
    const other = { ...state.projectGroups![2] }

    expect(
      operations.updateProjectGroups([
        { groupId: 'b', updates: { rootProjectOrder: 2000, tabOrder: 4 } },
        { groupId: 'a', updates: { rootProjectOrder: 1000, isCollapsed: true } }
      ])
    ).toMatchObject([
      { id: 'b', rootProjectOrder: 2000, tabOrder: 4 },
      { id: 'a', rootProjectOrder: 1000, isCollapsed: true }
    ])
    operations.updateProjectGroups([
      { groupId: 'a', updates: { rootProjectOrder: null } },
      { groupId: 'b', updates: { rootProjectOrder: 3000 } }
    ])

    expect(state.projectGroups).toMatchObject([
      { id: 'a', tabOrder: 0, isCollapsed: true },
      { id: 'b', rootProjectOrder: 3000, tabOrder: 4 },
      other
    ])
    expect(state.projectGroups![0].rootProjectOrder).toBeUndefined()
    expect(state.projectGroups![2]).toEqual(other)
  })

  it('rejects the entire batch when a group has disappeared', () => {
    const { state, operations } = fixture()
    const before = structuredClone(state.projectGroups)

    expect(
      operations.updateProjectGroups([
        { groupId: 'a', updates: { rootProjectOrder: 1000 } },
        { groupId: 'missing', updates: { rootProjectOrder: 2000 } }
      ])
    ).toBeNull()
    expect(state.projectGroups).toEqual(before)
  })
})
