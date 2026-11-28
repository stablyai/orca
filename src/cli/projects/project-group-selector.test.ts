import { describe, expect, it } from 'vitest'
import { createProjectGroup } from '../../shared/project/groups/project-groups'
import { findProjectGroup } from './project-group-selector'

function group(id: string, name: string) {
  return { ...createProjectGroup({ name, createdFrom: 'manual', tabOrder: 0 }), id }
}

// A move to an unmatched id silently ungroups the repo, so the CLI must never pass one through.
describe('findProjectGroup', () => {
  const groups = [
    group('g-1', 'Clients'),
    group('g-2', 'g-1'),
    group('g-3', 'Twin'),
    group('g-4', 'twin')
  ]

  it('picks exactly one listed group or refuses', () => {
    expect(findProjectGroup(groups, 'g-1').id).toBe('g-1')
    expect(findProjectGroup(groups, 'name:g-1').id).toBe('g-2')
    expect(findProjectGroup(groups, ' "clients" ').id).toBe('g-1')
    expect(() => findProjectGroup(groups, 'id:Clients')).toThrow('No project group matches')
    expect(() => findProjectGroup(groups, 'missing')).toThrow('No project group matches')
    expect(() => findProjectGroup(groups, 'TWIN')).toThrow('Ambiguous --group TWIN')
  })
})
