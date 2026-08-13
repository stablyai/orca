import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo } from '../shared/types'
import {
  formatProjectGroupAddResult,
  formatProjectGroupCreateResult,
  formatProjectGroupDeleteResult,
  formatProjectGroupList
} from './project-format'

function makeGroup(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 'grp-1',
    name: 'frontend',
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

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/tmp/repo',
    displayName: 'repo',
    badgeColor: '#000',
    addedAt: 0,
    ...overrides
  }
}

describe('project-format project groups', () => {
  it('lists groups with their parent path', () => {
    const output = formatProjectGroupList({
      groups: [makeGroup(), makeGroup({ id: 'grp-2', name: 'child', parentPath: '/tmp/umbrella' })]
    })
    expect(output).toBe('grp-1  frontend  parent:none\ngrp-2  child  parent:/tmp/umbrella')
  })

  it('reports when there are no groups', () => {
    expect(formatProjectGroupList({ groups: [] })).toBe('No project groups found.')
  })

  it('formats a created group', () => {
    expect(formatProjectGroupCreateResult({ group: makeGroup() })).toBe(
      'grp-1  frontend  parent:none'
    )
  })

  it('surfaces the repo actual resulting group after add', () => {
    expect(formatProjectGroupAddResult({ repo: makeRepo({ projectGroupId: 'grp-1' }) })).toBe(
      'repo: repo-1  group:grp-1'
    )
  })

  it('shows no group when the move ungrouped the repo', () => {
    expect(formatProjectGroupAddResult({ repo: makeRepo({ projectGroupId: null }) })).toBe(
      'repo: repo-1  group:none'
    )
  })

  it('reports delete outcomes', () => {
    expect(formatProjectGroupDeleteResult({ deleted: true })).toBe('deleted')
    expect(formatProjectGroupDeleteResult({ deleted: false })).toBe('not found')
  })
})
