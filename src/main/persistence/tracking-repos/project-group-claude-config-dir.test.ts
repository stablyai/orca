import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState } from '../../../shared/constants'
import { normalizeProjectGroups } from '../../../shared/project-groups'
import { ProjectGroupUpdate } from '../../../shared/rpc-contract/repo-params'
import { ProjectGroupUpdateArgs } from '../../ipc/repos/repo-ipc-arg-schemas'
import { ProjectGroupPersistenceOperations } from './project-group-operations'

function createOperations(): {
  operations: ProjectGroupPersistenceOperations
  state: ReturnType<typeof getDefaultPersistedState>
} {
  const state = getDefaultPersistedState('/home/test')
  const operations = new ProjectGroupPersistenceOperations({
    state,
    scheduleSave: () => {},
    removeWorkspaceLineageForFolderParent: () => {},
    pruneMobileClientTabSelections: () => {}
  })
  return { operations, state }
}

/** The wire shape the RPC handler forwards, so the test cannot drift from the contract. */
function parseUpdate(groupId: string, claudeConfigDir: string | null) {
  return ProjectGroupUpdate.parse({ groupId, updates: { claudeConfigDir } }).updates
}

describe('claudeConfigDir round trip', () => {
  it('persists a binding through projectGroup.update and survives reload normalization', () => {
    const { operations, state } = createOperations()
    const group = operations.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })

    expect(group.claudeConfigDir).toBeNull()

    const updated = operations.updateProjectGroup(
      group.id,
      parseUpdate(group.id, '/homes/platform')
    )

    expect(updated?.claudeConfigDir).toBe('/homes/platform')
    expect(normalizeProjectGroups(state.projectGroups)[0].claudeConfigDir).toBe('/homes/platform')
  })

  it('clears the binding when the update carries null', () => {
    const { operations, state } = createOperations()
    const group = operations.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
    operations.updateProjectGroup(group.id, parseUpdate(group.id, '/homes/platform'))

    const cleared = operations.updateProjectGroup(group.id, parseUpdate(group.id, null))

    expect(cleared?.claudeConfigDir).toBeNull()
    expect(normalizeProjectGroups(state.projectGroups)[0].claudeConfigDir).toBeNull()
  })

  it('treats an emptied field as a clear on both update hops', () => {
    for (const parse of [
      (groupId: string) => ProjectGroupUpdate.parse({ groupId, updates: { claudeConfigDir: '' } }),
      (groupId: string) =>
        ProjectGroupUpdateArgs.parse({ groupId, updates: { claudeConfigDir: '' } })
    ]) {
      const { operations, state } = createOperations()
      const group = operations.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
      operations.updateProjectGroup(group.id, parseUpdate(group.id, '/homes/platform'))

      const cleared = operations.updateProjectGroup(group.id, parse(group.id).updates)

      expect(cleared?.claudeConfigDir).toBeNull()
      expect(normalizeProjectGroups(state.projectGroups)[0].claudeConfigDir).toBeNull()
    }
  })

  it('keeps null and absent distinct on both update hops', () => {
    for (const schema of [ProjectGroupUpdate, ProjectGroupUpdateArgs]) {
      expect(schema.parse({ groupId: 'g', updates: { claudeConfigDir: null } }).updates).toEqual({
        claudeConfigDir: null
      })
      expect(
        schema.parse({ groupId: 'g', updates: { name: 'Core' } }).updates.claudeConfigDir
      ).toBe(undefined)
    }
  })

  it('discards a relative path at update time instead of persisting it', () => {
    const { operations, state } = createOperations()
    const group = operations.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
    operations.updateProjectGroup(group.id, parseUpdate(group.id, '/homes/platform'))

    const updated = operations.updateProjectGroup(group.id, parseUpdate(group.id, 'a/b'))

    expect(updated?.claudeConfigDir).toBeNull()
    expect(normalizeProjectGroups(state.projectGroups)[0].claudeConfigDir).toBeNull()
  })

  it('leaves the binding untouched when the update omits the field', () => {
    const { operations } = createOperations()
    const group = operations.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
    operations.updateProjectGroup(group.id, parseUpdate(group.id, '/homes/platform'))

    const renamed = operations.updateProjectGroup(
      group.id,
      ProjectGroupUpdate.parse({ groupId: group.id, updates: { name: 'Core' } }).updates
    )

    expect(renamed?.name).toBe('Core')
    expect(renamed?.claudeConfigDir).toBe('/homes/platform')
  })
})
