import { describe, expect, it } from 'vitest'
import type { PersistedState } from '../../../shared/orca-profiles/persisted-state-types'
import { createProjectGroup } from '../../../shared/project/groups/project-groups'
import { ProjectGroupPersistenceOperations } from './project-group-operations'

function groupTree(rootRank: { rootProjectOrder?: number } = { rootProjectOrder: 1000 }) {
  const make = (name: string, parentGroupId: string | null, tabOrder: number) =>
    createProjectGroup({ name, parentGroupId, createdFrom: 'manual', tabOrder })
  const root = { ...make('root', null, 5), ...rootRank }
  const child = make('child', root.id, 1)
  const grandchild = make('grandchild', child.id, 2)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: group parent moves read only repos and projectGroups.
  const state = { repos: [], projectGroups: [root, child, grandchild] } as unknown as PersistedState
  const operations = new ProjectGroupPersistenceOperations({
    state,
    scheduleSave: () => {},
    removeWorkspaceLineageForRemovedFolder: () => {},
    pruneMobileClientTabSelections: () => {}
  })
  return { operations, root, child, grandchild }
}

describe('setProjectGroupParents', () => {
  it('keeps the group tree acyclic and ranks a group moved to the top level last', () => {
    const { operations, root, child, grandchild } = groupTree()

    expect(
      operations.setProjectGroupParents([
        { groupId: root.id, parentGroupId: grandchild.id },
        { groupId: child.id, parentGroupId: child.id }
      ])
    ).toEqual([])
    expect(root.parentGroupId).toBeNull()

    operations.setProjectGroupParents([{ groupId: grandchild.id, parentGroupId: null }])
    expect(grandchild).toMatchObject({ parentGroupId: null, rootProjectOrder: 2000 })
  })

  it('places a group moved to an unranked top level past every other group', () => {
    const { operations, grandchild } = groupTree({})

    operations.setProjectGroupParents([{ groupId: grandchild.id, parentGroupId: null }])
    expect(grandchild).toMatchObject({ parentGroupId: null, tabOrder: 6 })
    expect(grandchild.rootProjectOrder).toBeUndefined()
  })
})
