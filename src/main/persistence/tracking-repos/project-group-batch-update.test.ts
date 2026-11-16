import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { createProjectGroup } from '../../../shared/project/groups/project-groups'
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
