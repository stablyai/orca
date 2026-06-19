import { describe, expect, it } from 'vitest'
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoImportPaths,
  resolveNestedRepoSelection
} from './nested-repo-import'
import type { ProjectGroup } from '../../shared/types'

function createGroupRecorder(): {
  groups: ProjectGroup[]
  createGroup: (input: {
    name: string
    parentPath?: string | null
    connectionId?: string | null
    parentGroupId?: string | null
    createdFrom: ProjectGroup['createdFrom']
  }) => ProjectGroup
} {
  const groups: ProjectGroup[] = []
  return {
    groups,
    createGroup: (input) => {
      const group: ProjectGroup = {
        id: `group-${groups.length}`,
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
    }
  }
}

describe('createNestedProjectGroupResolver', () => {
  it('creates sparse folder scopes for nested repos in grouped imports', () => {
    const groups: ProjectGroup[] = []
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace',
      groupName: 'workspace',
      mode: 'group',
      repoPaths: [
        '/workspace/gateway-api',
        '/workspace/services/payments/api',
        '/workspace/services/payments/worker'
      ],
      createGroup: (input) => {
        const group: ProjectGroup = {
          id: `group-${groups.length}`,
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
      }
    })

    const direct = resolver.getGroupForRepo('/workspace/gateway-api')
    const nested = resolver.getGroupForRepo('/workspace/services/payments/api')
    const sibling = resolver.getGroupForRepo('/workspace/services/payments/worker')

    expect(direct?.name).toBe('workspace')
    expect(nested?.name).toBe('services/payments')
    expect(sibling?.id).toBe(nested?.id)
    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['workspace', null, '/workspace'],
      ['services/payments', 'group-0', '/workspace/services/payments']
    ])
    expect(resolver.getRootGroup()?.id).toBe('group-0')
  })

  it('skips intermediate folders that only lead to one meaningful child scope', () => {
    const { groups, createGroup } = createGroupRecorder()
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace/platform',
      groupName: 'Platform',
      mode: 'group',
      repoPaths: [
        '/workspace/platform/api',
        '/workspace/platform/web',
        '/workspace/platform/packages/shared/repo1',
        '/workspace/platform/packages/shared/repo2'
      ],
      createGroup
    })

    const api = resolver.getGroupForRepo('/workspace/platform/api')
    const repo1 = resolver.getGroupForRepo('/workspace/platform/packages/shared/repo1')
    const repo2 = resolver.getGroupForRepo('/workspace/platform/packages/shared/repo2')

    expect(api?.name).toBe('Platform')
    expect(repo1?.name).toBe('packages/shared')
    expect(repo2?.id).toBe(repo1?.id)
    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, '/workspace/platform'],
      ['packages/shared', 'group-0', '/workspace/platform/packages/shared']
    ])
  })

  it('creates a parent folder scope when it has direct repos and nested descendants', () => {
    const { groups, createGroup } = createGroupRecorder()
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace/platform',
      groupName: 'Platform',
      mode: 'group',
      repoPaths: ['/workspace/platform/services/api', '/workspace/platform/services/jobs/worker'],
      createGroup
    })

    const direct = resolver.getGroupForRepo('/workspace/platform/services/api')
    const nested = resolver.getGroupForRepo('/workspace/platform/services/jobs/worker')

    expect(direct?.name).toBe('services')
    expect(nested?.id).toBe(direct?.id)
    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, '/workspace/platform'],
      ['services', 'group-0', '/workspace/platform/services']
    ])
  })

  it('does not create groups for separate imports', () => {
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace',
      groupName: 'workspace',
      mode: 'separate',
      repoPaths: ['/workspace/services/api', '/workspace/services/worker'],
      createGroup: () => {
        throw new Error('should not create a group')
      }
    })

    expect(resolver.getGroupForRepo('/workspace/services/api')).toBeUndefined()
    expect(resolver.getCreatedGroups()).toEqual([])
  })

  it('preserves filesystem root parent paths when creating the root group', () => {
    const groups: ProjectGroup[] = []
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/',
      groupName: 'root',
      mode: 'group',
      repoPaths: ['/api', '/services/api'],
      createGroup: (input) => {
        const group: ProjectGroup = {
          id: `group-${groups.length}`,
          name: input.name,
          parentPath: input.parentPath ?? null,
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
      }
    })

    resolver.getGroupForRepo('/api')
    resolver.getGroupForRepo('/services/api')

    expect(groups.map((group) => group.parentPath)).toEqual(['/'])
  })

  it('preserves Windows drive roots when creating the root group', () => {
    const groups: ProjectGroup[] = []
    const resolver = createNestedProjectGroupResolver({
      parentPath: 'C:\\',
      groupName: 'C',
      mode: 'group',
      repoPaths: ['C:\\api', 'C:\\services\\api'],
      createGroup: (input) => {
        const group: ProjectGroup = {
          id: `group-${groups.length}`,
          name: input.name,
          parentPath: input.parentPath ?? null,
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
      }
    })

    resolver.getGroupForRepo('C:\\api')
    resolver.getGroupForRepo('C:\\services\\api')

    expect(groups.map((group) => group.parentPath)).toEqual(['C:/'])
  })

  it('creates sparse folder scopes for Windows repo paths', () => {
    const { groups, createGroup } = createGroupRecorder()
    const resolver = createNestedProjectGroupResolver({
      parentPath: 'C:\\workspace\\platform',
      groupName: 'Platform',
      mode: 'group',
      repoPaths: [
        'C:\\workspace\\platform\\apps\\web',
        'C:\\workspace\\platform\\packages\\shared\\repo1',
        'C:\\workspace\\platform\\packages\\shared\\repo2'
      ],
      createGroup
    })

    const web = resolver.getGroupForRepo('C:\\workspace\\platform\\apps\\web')
    const repo1 = resolver.getGroupForRepo('C:\\workspace\\platform\\packages\\shared\\repo1')

    expect(web?.name).toBe('Platform')
    expect(repo1?.name).toBe('packages/shared')
    expect(groups.map((group) => [group.name, group.parentGroupId, group.parentPath])).toEqual([
      ['Platform', null, 'C:/workspace/platform'],
      ['packages/shared', 'group-0', 'C:/workspace/platform/packages/shared']
    ])
  })

  it('preserves SSH provenance on grouped folder scopes', () => {
    const { groups, createGroup } = createGroupRecorder()
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace/platform',
      groupName: 'Platform',
      mode: 'group',
      connectionId: 'ssh-1',
      repoPaths: [
        '/workspace/platform/packages/shared/repo1',
        '/workspace/platform/packages/shared/repo2'
      ],
      createGroup
    })

    resolver.getGroupForRepo('/workspace/platform/packages/shared/repo1')

    expect(groups.map((group) => [group.name, group.connectionId])).toEqual([
      ['Platform', 'ssh-1'],
      ['packages/shared', 'ssh-1']
    ])
  })

  it('falls back to the selected parent folder basename for blank group names', () => {
    const groups: ProjectGroup[] = []
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace/platform',
      groupName: '   ',
      mode: 'group',
      createGroup: (input) => {
        const group: ProjectGroup = {
          id: `group-${groups.length}`,
          name: input.name,
          parentPath: input.parentPath ?? null,
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
      }
    })

    resolver.getGroupForRepo('/workspace/platform/apps/web')

    expect(groups.map((group) => group.name)).toEqual(['platform'])
  })

  it('resolves Windows-style repo paths back to canonical scan output', () => {
    const selection = resolveNestedRepoSelection({
      scan: {
        selectedPath: 'C:\\workspace',
        selectedPathKind: 'non_git_folder',
        repos: [
          { path: 'C:\\workspace\\Services\\API', displayName: 'API', depth: 2 },
          { path: 'C:\\workspace\\tools', displayName: 'tools', depth: 1 }
        ],
        truncated: false,
        timedOut: false,
        stopped: false,
        durationMs: 1,
        maxDepth: 3,
        maxRepos: 100,
        timeoutMs: null
      },
      projectPaths: ['c:/workspace/services/api', 'C:/workspace/services/api', 'D:/other/repo']
    })

    expect(selection.selectedPaths).toEqual(['C:\\workspace\\Services\\API'])
    expect(selection.rejectedPaths).toEqual(['D:/other/repo'])
  })

  it('accepts stopped-scan import paths inside the selected parent without rescanning', () => {
    const selection = resolveNestedRepoImportPaths({
      parentPath: '/workspace/platform',
      projectPaths: [
        '/workspace/platform/api',
        '/workspace/platform/api',
        '/workspace/platform/apps/web',
        '/workspace/other/repo'
      ]
    })

    expect(selection.selectedPaths).toEqual([
      '/workspace/platform/api',
      '/workspace/platform/apps/web'
    ])
    expect(selection.rejectedPaths).toEqual(['/workspace/other/repo'])
  })

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

  it('rejects stopped-scan import requests with a relative parent path', () => {
    const selection = resolveNestedRepoImportPaths({
      parentPath: 'workspace/platform',
      projectPaths: ['workspace/platform/api', '/workspace/platform/api']
    })

    expect(selection.selectedPaths).toEqual([])
    expect(selection.rejectedPaths).toEqual(['workspace/platform/api', '/workspace/platform/api'])
  })

  it('normalizes accepted stopped-scan import paths before importing', () => {
    const selection = resolveNestedRepoImportPaths({
      parentPath: 'C:\\workspace\\platform',
      projectPaths: [
        'C:\\workspace\\platform\\api',
        'C:\\workspace\\platform\\apps\\..\\tools',
        'C:\\workspace\\outside'
      ]
    })

    expect(selection.selectedPaths).toEqual([
      'C:/workspace/platform/api',
      'C:/workspace/platform/tools'
    ])
    expect(selection.rejectedPaths).toEqual(['C:\\workspace\\outside'])
  })
})
