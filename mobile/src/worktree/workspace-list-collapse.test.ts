import { describe, expect, it } from 'vitest'
import { collapseWorkspaceListSections } from './workspace-list-collapse'
import type { Section } from './workspace-list-types'

function section(
  key: string,
  depth: number,
  data: string[] = [],
  kind: Section['kind'] = 'repo'
): Section {
  return {
    key,
    title: key,
    kind,
    depth,
    count: data.length,
    data: data.map((worktreeId) => ({ worktreeId }) as Section['data'][number])
  }
}

describe('collapseWorkspaceListSections', () => {
  const tree = [
    section('project-group:work', 0, [], 'project-group'),
    section('repo:orca', 1, ['wt-1']),
    section('project-group:clients', 1, [], 'project-group'),
    section('repo:client', 2, ['wt-2']),
    section('repo:notes', 0, ['wt-3'])
  ]

  it('empties a collapsed section and hides its descendants', () => {
    const visible = collapseWorkspaceListSections(tree, new Set(['project-group:work']))
    expect(visible.map((entry) => entry.key)).toEqual(['project-group:work', 'repo:notes'])
    expect(visible[0]?.data).toEqual([])
    expect(visible[1]?.data.map((item) => item.worktreeId)).toEqual(['wt-3'])
  })

  it('can collapse a nested group without hiding its siblings', () => {
    const visible = collapseWorkspaceListSections(tree, new Set(['project-group:clients']))
    expect(visible.map((entry) => entry.key)).toEqual([
      'project-group:work',
      'repo:orca',
      'project-group:clients',
      'repo:notes'
    ])
  })
})
