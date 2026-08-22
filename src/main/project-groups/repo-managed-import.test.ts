import { describe, expect, it } from 'vitest'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import { importRepoManagedProject } from './repo-managed-import'

function makeStore(seed?: { groups?: ProjectGroup[]; workspaces?: FolderWorkspace[] }) {
  const groups = [...(seed?.groups ?? [])]
  const workspaces = [...(seed?.workspaces ?? [])]
  return {
    getProjectGroups: () => groups,
    getFolderWorkspaces: () => workspaces,
    createProjectGroup: (input: {
      name: string
      parentPath?: string | null
      connectionId?: string | null
      parentGroupId?: string | null
      createdFrom: ProjectGroup['createdFrom']
    }): ProjectGroup => {
      const group: ProjectGroup = {
        id: `group-${groups.length + 1}`,
        name: input.name,
        parentPath: input.parentPath ?? null,
        connectionId: input.connectionId ?? null,
        parentGroupId: input.parentGroupId ?? null,
        createdFrom: input.createdFrom,
        tabOrder: groups.length,
        isCollapsed: false,
        color: null,
        createdAt: 1,
        updatedAt: 1
      }
      groups.push(group)
      return group
    },
    createFolderWorkspace: (input: {
      projectGroupId: string
      name?: string
      folderPath?: string | null
      connectionId?: string | null
    }): FolderWorkspace => {
      const workspace: FolderWorkspace = {
        id: `ws-${workspaces.length + 1}`,
        projectGroupId: input.projectGroupId,
        name: input.name ?? 'workspace',
        folderPath: input.folderPath ?? '/missing',
        connectionId: input.connectionId ?? null,
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 1,
        lastActivityAt: 0,
        createdAt: 1,
        updatedAt: 1
      }
      workspaces.push(workspace)
      return workspace
    }
  }
}

describe('importRepoManagedProject', () => {
  it('creates one group and a main folder workspace without importing nested git repos', () => {
    const store = makeStore()
    const result = importRepoManagedProject({
      store,
      parentPath: '/src/aosp',
      groupName: 'AOSP'
    })

    expect(result.group?.createdFrom).toBe('repo-managed')
    expect(result.group?.parentPath).toBe('/src/aosp')
    expect(result.importedCount).toBe(1)
    expect(result.alreadyKnownCount).toBe(0)
    expect(store.getFolderWorkspaces()).toEqual([
      expect.objectContaining({
        projectGroupId: result.group?.id,
        folderPath: '/src/aosp',
        name: 'AOSP'
      })
    ])
    expect(result.projects).toHaveLength(1)
  })

  it('reuses an existing group and main workspace at the same path', () => {
    const store = makeStore()
    const first = importRepoManagedProject({ store, parentPath: '/src/aosp' })
    const second = importRepoManagedProject({ store, parentPath: '/src/aosp' })

    expect(second.group?.id).toBe(first.group?.id)
    expect(second.alreadyKnownCount).toBe(1)
    expect(second.importedCount).toBe(0)
    expect(store.getProjectGroups()).toHaveLength(1)
    expect(store.getFolderWorkspaces()).toHaveLength(1)
  })
})
