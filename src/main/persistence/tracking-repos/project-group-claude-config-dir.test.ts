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

  // Why every spelling: an unparseable path must be a rejected write, never the silent clear that
  // `null` means — `~/.claude-work` is the most natural thing a user types into that field.
  it.each([
    ['home-relative', '~/.claude-work'],
    ['explicitly relative', './claude'],
    ['bare name', 'claude-work'],
    ['drive-relative with no slash', 'C:alice'],
    ['drive-relative with no drive', '\\Users\\alice'],
    ['plainly relative', 'a/b']
  ])('rejects an unparseable %s path at both update hops and keeps the binding', (_label, path) => {
    for (const schema of [ProjectGroupUpdate, ProjectGroupUpdateArgs]) {
      const { operations, state } = createOperations()
      const group = operations.createProjectGroup({ name: 'Platform', createdFrom: 'manual' })
      operations.updateProjectGroup(group.id, parseUpdate(group.id, '/homes/platform'))

      const parsed = schema.safeParse({
        groupId: group.id,
        updates: { claudeConfigDir: path }
      })

      expect(parsed.success).toBe(false)
      expect(normalizeProjectGroups(state.projectGroups)[0].claudeConfigDir).toBe('/homes/platform')
    }
  })

  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an array', []],
    ['an object', {}]
  ])('rejects %s rather than reading it as "no update"', (_label, value) => {
    for (const schema of [ProjectGroupUpdate, ProjectGroupUpdateArgs]) {
      expect(schema.safeParse({ groupId: 'g', updates: { claudeConfigDir: value } }).success).toBe(
        false
      )
    }
  })

  // Mixed-version tolerance: an older client that never heard of the field must stay "no update".
  it('accepts an update that omits the field on both hops', () => {
    for (const schema of [ProjectGroupUpdate, ProjectGroupUpdateArgs]) {
      const parsed = schema.safeParse({ groupId: 'g', updates: { name: 'Core' } })
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data.updates.claudeConfigDir).toBe(undefined)
    }
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
