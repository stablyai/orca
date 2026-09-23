import { describe, expect, it, vi } from 'vitest'
import type { ProjectGroup } from '../../shared/project-group-types'
import { RuntimeProjectGroupController } from './runtime-project-group-controller'
import type { RuntimeStore } from './runtime-store-contract'

const existingGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Work',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

function createController() {
  const onClaudeHomeBindingChanged = vi.fn()
  const updateProjectGroup = vi.fn((): ProjectGroup | null => existingGroup)
  const deleteProjectGroup = vi.fn((): boolean => true)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: updateGroup and deleteGroup read only these two store methods, so no other RuntimeStore member is reachable from this test.
  const store = { updateProjectGroup, deleteProjectGroup } as unknown as RuntimeStore
  const controller = new RuntimeProjectGroupController({
    getStore: () => store,
    resolveRepo: async () => {
      throw new Error('unused')
    },
    notifyReposChanged: vi.fn(),
    resolveFolderConnectionId: () => null,
    teardownFolderWorkspacePtys: async () => undefined,
    cleanupRemovedFolderWorkspaceState: vi.fn(),
    onClaudeHomeBindingChanged
  })
  return { controller, onClaudeHomeBindingChanged, updateProjectGroup, deleteProjectGroup }
}

describe('bound Claude home eviction on group changes', () => {
  it('evicts the cached usage row when a group rebinds its config dir', async () => {
    const deps = createController()

    await deps.controller.updateGroup('group-1', { claudeConfigDir: '/Users/dana/.claude-work' })

    expect(deps.onClaudeHomeBindingChanged).toHaveBeenCalledWith('group-1')
  })

  it('evicts the cached usage row when a group is deleted', async () => {
    const deps = createController()

    await deps.controller.deleteGroup('group-1')

    expect(deps.onClaudeHomeBindingChanged).toHaveBeenCalledWith('group-1')
  })

  it('leaves the row alone for an update that cannot change a binding', async () => {
    const deps = createController()

    await deps.controller.updateGroup('group-1', { name: 'Renamed' })

    expect(deps.onClaudeHomeBindingChanged).not.toHaveBeenCalled()
  })

  it('does not evict when the store rejected the change', async () => {
    const deps = createController()
    deps.updateProjectGroup.mockReturnValueOnce(null)
    deps.deleteProjectGroup.mockReturnValueOnce(false)

    await deps.controller.updateGroup('group-1', { claudeConfigDir: '/Users/dana/.claude-work' })
    await deps.controller.deleteGroup('group-1')

    expect(deps.onClaudeHomeBindingChanged).not.toHaveBeenCalled()
  })
})
