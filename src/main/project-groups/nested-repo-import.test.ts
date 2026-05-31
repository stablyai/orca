import { describe, expect, it } from 'vitest'
import { createNestedProjectGroupResolver, resolveNestedRepoSelection } from './nested-repo-import'
import type { ProjectGroup } from '../../shared/types'

describe('createNestedProjectGroupResolver', () => {
  it('creates a root group plus intermediate directory groups for nested repos', () => {
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
    expect(nested?.name).toBe('payments')
    expect(sibling?.id).toBe(nested?.id)
    expect(groups.map((group) => [group.name, group.parentGroupId])).toEqual([
      ['workspace', null],
      ['services', 'group-0'],
      ['payments', 'group-1']
    ])
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

  it('preserves filesystem root parent paths when creating groups', () => {
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

    expect(groups.map((group) => group.parentPath)).toEqual(['/', '/services'])
  })

  it('preserves Windows drive roots when creating groups', () => {
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

    expect(groups.map((group) => group.parentPath)).toEqual(['C:/', 'C:/services'])
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
        durationMs: 1,
        maxDepth: 3
      },
      projectPaths: ['c:/workspace/services/api', 'C:/workspace/services/api', 'D:/other/repo']
    })

    expect(selection.selectedPaths).toEqual(['C:\\workspace\\Services\\API'])
    expect(selection.rejectedPaths).toEqual(['D:/other/repo'])
  })
})
