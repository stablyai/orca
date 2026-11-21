import { describe, expect, it } from 'vitest'
import type {
  ProjectGroup,
  ProjectGroupParentMove
} from '../../shared/project/groups/project-group-types'
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoImportPaths
} from './nested-repo-import'

function folderScanGroup(
  overrides: Partial<ProjectGroup> & Pick<ProjectGroup, 'id' | 'parentPath'>
): ProjectGroup {
  return {
    name: 'PARENT',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function createTestGroup(input: { name: string; parentPath?: string | null }): ProjectGroup {
  return folderScanGroup({ id: 'created', name: input.name, parentPath: input.parentPath ?? null })
}

describe('createNestedProjectGroupResolver', () => {
  it('rejects stopped-scan import paths that escape the selected parent with dot segments', () => {
    const selection = resolveNestedRepoImportPaths({
      parentPath: '/workspace/platform',
      projectPaths: [
        '/workspace/platform/api',
        '/workspace/platform/../outside-repo',
        '/workspace/platform/apps/../../other-outside-repo'
      ]
    })

    expect(selection.selectedPaths).toEqual(['/workspace/platform/api'])
    expect(selection.rejectedPaths).toEqual([
      '/workspace/platform/../outside-repo',
      '/workspace/platform/apps/../../other-outside-repo'
    ])
  })

  it('reuses folder-scan groups for a rescanned parent and keeps them out of rollback', () => {
    const root = folderScanGroup({ id: 'root', parentPath: '/work/PARENT/' })
    const shared = folderScanGroup({
      id: 'shared',
      name: 'packages/shared',
      parentPath: '/work/PARENT/packages/shared',
      parentGroupId: 'root'
    })
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work/PARENT',
      groupName: 'PARENT',
      mode: 'group',
      repoPaths: [
        '/work/PARENT/new-repo',
        '/work/PARENT/packages/shared/repo1',
        '/work/PARENT/packages/shared/repo2'
      ],
      existingGroups: [
        folderScanGroup({ id: 'remote', parentPath: '/work/PARENT', connectionId: 'ssh-1' }),
        root,
        shared
      ],
      createGroup: createTestGroup
    })

    expect(resolver.getGroupForRepo('/work/PARENT/new-repo')?.id).toBe('root')
    expect(resolver.getGroupForRepo('/work/PARENT/packages/shared/repo1')?.id).toBe('shared')
    expect(resolver.getCreatedGroups()).toEqual([])
  })

  it('prefers duplicate groups that hold repos', () => {
    const sharedPath = '/work/PARENT/packages/shared'
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work/PARENT',
      groupName: 'PARENT',
      mode: 'group',
      repoPaths: [`${sharedPath}/repo1`, `${sharedPath}/repo2`],
      existingGroups: [
        folderScanGroup({ id: 'empty-root', parentPath: '/work/PARENT' }),
        folderScanGroup({ id: 'root', parentPath: '/work/PARENT' }),
        folderScanGroup({ id: 'empty-shared', parentPath: sharedPath, parentGroupId: 'root' }),
        folderScanGroup({ id: 'shared', parentPath: sharedPath, parentGroupId: 'root' })
      ],
      existingRepos: [{ projectGroupId: 'shared' }],
      createGroup: createTestGroup
    })

    expect(resolver.getGroupForRepo(`${sharedPath}/repo1`)?.id).toBe('shared')
    expect(resolver.getRootGroup()?.id).toBe('root')
  })

  it('moves a reused subgroup under a new folder scope only once changes are applied', () => {
    const reparented: ProjectGroupParentMove[] = []
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/work/PARENT',
      groupName: 'PARENT',
      mode: 'group',
      repoPaths: [
        '/work/PARENT/packages/tool',
        '/work/PARENT/packages/shared/repo1',
        '/work/PARENT/packages/shared/repo2'
      ],
      existingGroups: [
        folderScanGroup({ id: 'root', parentPath: '/work/PARENT' }),
        folderScanGroup({
          id: 'shared',
          parentPath: '/work/PARENT/packages/shared',
          parentGroupId: 'root'
        })
      ],
      createGroup: createTestGroup,
      reparentGroups: (moves) => reparented.push(...moves)
    })

    expect(resolver.getGroupForRepo('/work/PARENT/packages/shared/repo1')?.id).toBe('shared')
    expect(resolver.getCreatedGroups().map((group) => group.parentPath)).toEqual([
      '/work/PARENT/packages'
    ])
    // Rollback deletes created subtrees, so the reused group must not sit under one yet.
    expect(reparented).toEqual([])
    resolver.applyReusedGroupChanges()
    expect(reparented).toEqual([{ groupId: 'shared', parentGroupId: 'created' }])
  })
})
