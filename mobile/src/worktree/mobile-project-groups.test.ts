import { describe, expect, it } from 'vitest'
import {
  buildRepoProjectGroupIdByRepoId,
  readProjectGroupListResult,
  readRepoProjectGroupId
} from './mobile-project-groups'

describe('mobile project group RPC parse', () => {
  it('keeps a string membership and drops blanks', () => {
    expect(readRepoProjectGroupId({ projectGroupId: 'group-1' })).toBe('group-1')
    expect(readRepoProjectGroupId({ projectGroupId: '' })).toBeNull()
    expect(readRepoProjectGroupId({})).toBeNull()
  })

  it('indexes repo.list membership for the section builder', () => {
    expect([
      ...buildRepoProjectGroupIdByRepoId([
        { id: 'repo-1', projectGroupId: 'work' },
        { id: 'repo-2' }
      ])
    ]).toEqual([
      ['repo-1', 'work'],
      ['repo-2', null]
    ])
  })

  it('normalizes projectGroup.list and ignores junk rows', () => {
    const groups = readProjectGroupListResult({
      groups: [
        { id: 'work', name: 'Work', tabOrder: 1, createdFrom: 'manual' },
        { id: 'dup', name: 'Dup' },
        { id: 'dup', name: 'Ignored duplicate' },
        { name: 'missing-id' },
        null
      ]
    })
    expect(groups.map((group) => group.id)).toEqual(['dup', 'work'])
    expect(readProjectGroupListResult(null)).toEqual([])
    expect(readProjectGroupListResult({ groups: 'nope' })).toEqual([])
  })
})
