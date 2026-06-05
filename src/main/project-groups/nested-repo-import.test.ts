import { describe, expect, it } from 'vitest'
import {
  createNestedProjectGroupResolver,
  resolveNestedRepoImportPaths,
  resolveNestedRepoSelection
} from './nested-repo-import'
import type { ProjectGroup } from '../../shared/types'

describe('createNestedProjectGroupResolver', () => {
  it('creates one root group for nested repos in grouped imports', () => {
    const groups: ProjectGroup[] = []
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace',
      groupName: 'workspace',
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

    const direct = resolver.getGroupForRepo('/workspace/gateway-api')
    const nested = resolver.getGroupForRepo('/workspace/services/payments/api')
    const sibling = resolver.getGroupForRepo('/workspace/services/payments/worker')

    expect(direct?.name).toBe('workspace')
    expect(nested?.name).toBe('workspace')
    expect(sibling?.id).toBe(nested?.id)
    expect(groups.map((group) => [group.name, group.parentGroupId])).toEqual([['workspace', null]])
    expect(resolver.getRootGroup()?.id).toBe('group-0')
  })

  it('does not create groups for separate imports', () => {
    const resolver = createNestedProjectGroupResolver({
      parentPath: '/workspace',
      groupName: 'workspace',
      mode: 'separate',
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
