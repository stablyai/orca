import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/orca-profiles/constants'
import { ProjectGroupPersistenceOperations } from './project-group-operations'

function createGroupOperations(): ProjectGroupPersistenceOperations {
  return new ProjectGroupPersistenceOperations({
    state: getDefaultPersistedState('/home/test'),
    scheduleSave: () => {},
    removeWorkspaceLineageForRemovedFolder: () => {},
    pruneMobileClientTabSelections: () => {}
  })
}

describe('setProjectGroupParents', () => {
  it('moves groups in order and skips moves that would form a cycle', () => {
    const groups = createGroupOperations()
    const root = groups.createProjectGroup({ name: 'root', createdFrom: 'folder-scan' })
    const outer = groups.createProjectGroup({
      name: 'outer',
      parentGroupId: root.id,
      createdFrom: 'folder-scan'
    })
    const inner = groups.createProjectGroup({
      name: 'inner',
      parentGroupId: root.id,
      createdFrom: 'folder-scan'
    })

    const moved = groups.setProjectGroupParents([
      { groupId: inner.id, parentGroupId: outer.id },
      { groupId: outer.id, parentGroupId: inner.id },
      { groupId: root.id, parentGroupId: inner.id },
      { groupId: outer.id, parentGroupId: outer.id },
      { groupId: outer.id, parentGroupId: 'missing' }
    ])

    expect(moved.map((group) => group.name)).toEqual(['inner'])
    expect(groups.getProjectGroups().map((group) => [group.name, group.parentGroupId])).toEqual([
      ['root', null],
      ['outer', root.id],
      ['inner', outer.id]
    ])
  })
})
