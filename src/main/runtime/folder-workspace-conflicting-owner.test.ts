import { describe, expect, it, vi } from 'vitest'
import { toSshExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace, ProjectGroup } from '../../shared/types'
import { OrcaRuntimeService } from './orca-runtime'

const targetId = 'conflicting-owner'
const executionHostId = toSshExecutionHostId(targetId)

const group: ProjectGroup = {
  id: 'conflicting-group',
  name: 'Conflicting group',
  parentPath: '/workspace/conflicting',
  connectionId: null,
  executionHostId,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const workspace: FolderWorkspace = {
  id: 'conflicting-folder',
  projectGroupId: group.id,
  name: 'Conflicting folder',
  folderPath: '/workspace/conflicting',
  connectionId: null,
  executionHostId,
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0,
  createdAt: 1,
  updatedAt: 1
}

describe('runtime folder owner conflicts', () => {
  it.each([
    { label: 'without a requested host', executionHostId: undefined },
    { label: 'with the advertised SSH host', executionHostId }
  ])('rejects folder and group mutations $label', async (testCase) => {
    const updateProjectGroup = vi.fn()
    const deleteProjectGroup = vi.fn()
    const updateFolderWorkspace = vi.fn()
    const removeFolderWorkspace = vi.fn()
    const runtime = new OrcaRuntimeService({
      getRepos: () => [],
      getProjectGroups: () => [group],
      getFolderWorkspaces: () => [workspace],
      updateProjectGroup,
      deleteProjectGroup,
      updateFolderWorkspace,
      removeFolderWorkspace
    } as never)
    const options = testCase.executionHostId
      ? { executionHostId: testCase.executionHostId as ExecutionHostId }
      : undefined

    await expect(
      runtime.updateProjectGroup(group.id, { name: 'Updated' }, options)
    ).resolves.toBeNull()
    await expect(
      runtime.updateFolderWorkspace(workspace.id, { name: 'Updated' }, options)
    ).resolves.toBeNull()
    await expect(runtime.deleteProjectGroup(group.id, options)).resolves.toEqual({
      deleted: false
    })
    await expect(runtime.deleteFolderWorkspace(workspace.id, options)).resolves.toEqual({
      deleted: false
    })
    expect(updateProjectGroup).not.toHaveBeenCalled()
    expect(deleteProjectGroup).not.toHaveBeenCalled()
    expect(updateFolderWorkspace).not.toHaveBeenCalled()
    expect(removeFolderWorkspace).not.toHaveBeenCalled()
  })
})
