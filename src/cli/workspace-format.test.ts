import { describe, expect, it } from 'vitest'

import type { ProjectGroup } from '../shared/types'
import { formatProjectGroupList, formatProjectGroupShow } from './workspace-format'

function projectGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Clients',
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

describe('formatProjectGroupList', () => {
  it('reports when no groups exist', () => {
    expect(formatProjectGroupList({ groups: [] })).toBe('No project groups found.')
  })

  it('lists id, name, color, and parent per group', () => {
    const output = formatProjectGroupList({
      groups: [
        projectGroup(),
        projectGroup({ id: 'group-2', name: 'Nested', color: '#ff8800', parentGroupId: 'group-1' })
      ]
    })

    expect(output).toContain('group-1  Clients  color:none  parent:none')
    expect(output).toContain('group-2  Nested  color:#ff8800  parent:group-1')
  })
})

describe('formatProjectGroupShow', () => {
  it('shows one group as key/value lines', () => {
    const output = formatProjectGroupShow({ group: projectGroup({ color: '#ff8800' }) })

    expect(output).toContain('id: group-1')
    expect(output).toContain('name: Clients')
    expect(output).toContain('color: #ff8800')
    expect(output).toContain('parentGroupId: null')
  })
})
