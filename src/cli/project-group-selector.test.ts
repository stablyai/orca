import { describe, expect, it } from 'vitest'

import type { ProjectGroup } from '../shared/types'
import { resolveProjectGroupFromList } from './project-group-selector'
import { RuntimeClientError } from './runtime-client'

function group(id: string, name: string): ProjectGroup {
  return {
    id,
    name,
    parentPath: null,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 0,
    updatedAt: 0
  }
}

const GROUPS = [group('g1', 'Clients'), group('g2', 'Internal'), group('g3', 'Clients')]

describe('resolveProjectGroupFromList', () => {
  it('resolves an id: selector', () => {
    expect(resolveProjectGroupFromList(GROUPS, 'id:g2').id).toBe('g2')
  })

  it('resolves a unique name: selector', () => {
    expect(resolveProjectGroupFromList(GROUPS, 'name:Internal').id).toBe('g2')
  })

  it('resolves a bare id before falling back to name', () => {
    expect(resolveProjectGroupFromList(GROUPS, 'g1').id).toBe('g1')
  })

  it('resolves a bare unique name', () => {
    expect(resolveProjectGroupFromList(GROUPS, 'Internal').id).toBe('g2')
  })

  it('throws selector_ambiguous for a duplicated name', () => {
    expect(() => resolveProjectGroupFromList(GROUPS, 'name:Clients')).toThrowError(
      RuntimeClientError
    )
    try {
      resolveProjectGroupFromList(GROUPS, 'Clients')
    } catch (error) {
      expect((error as RuntimeClientError).code).toBe('selector_ambiguous')
    }
  })

  it('throws selector_not_found for an unknown selector', () => {
    try {
      resolveProjectGroupFromList(GROUPS, 'name:Nope')
      expect.unreachable()
    } catch (error) {
      expect((error as RuntimeClientError).code).toBe('selector_not_found')
    }
  })
})
