import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from './mobile-tasks-provider-detail-types'
import {
  sortLinearIssues,
  groupLinearIssues,
  groupSortedLinearIssues
} from './mobile-tasks-reviewer-linear'

vi.mock('./mobile-tasks-dependencies', () => import('../theme/mobile-theme'))
afterEach(() => vi.restoreAllMocks())

const issues: LinearIssue[] = Array.from({ length: 60 }, (_, i) => ({
  id: `${i}`,
  identifier: ['ENG-10', 'ENG-2', 'Ä-1', 'Å-1', 'é-2', 'e\u0301-2', 'İ-3'][i % 7],
  title: 'Task',
  url: '',
  labels: [],
  priority: i % 5,
  updatedAt: ['2026-02-01', 'invalid', '1970-01-01', '2026-02-01', '2025-01-01'][
    Math.floor(i / 5) % 5
  ],
  state: { name: i % 2 ? 'Todo' : 'Done', type: 'started', color: '' },
  team: { id: `${i % 3}`, name: `Team ${i % 3}`, key: 'ENG' }
}))

describe('mobile Linear grouping of sorted issues', () => {
  it.each(['updated', 'identifier', 'priority'] as const)(
    'preserves %s ordering, ties and group metadata',
    (order) => {
      const sorted = Object.freeze(sortLinearIssues(issues, order))
      for (const group of ['none', 'status', 'assignee', 'team', 'priority'] as const) {
        const expected = groupLinearIssues([...sorted], group, order)
        const actual = groupSortedLinearIssues(sorted, group)
        expect(actual).toEqual(expected)
        actual.forEach((section, index) => {
          expect(section.issues).not.toBe(sorted)
          section.issues.forEach((issue, offset) =>
            expect(issue).toBe(expected[index].issues[offset])
          )
        })
      }
    }
  )

  it('does no date parsing or collation after ordering has been established', () => {
    const sorted = sortLinearIssues(issues, 'updated')
    const parse = vi.spyOn(Date, 'parse')
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    groupSortedLinearIssues(sorted, 'none')
    groupSortedLinearIssues(sorted, 'status')
    expect(parse).not.toHaveBeenCalled()
    expect(compare).not.toHaveBeenCalled()
    groupLinearIssues(sorted, 'status', 'updated')
    expect(parse).toHaveBeenCalled()
  })

  it('returns independent issue arrays for empty, singleton and ungrouped inputs', () => {
    for (const input of [[], [issues[0]], issues]) {
      const sorted = Object.freeze([...input])
      const first = groupSortedLinearIssues(sorted, 'none')
      const second = groupSortedLinearIssues(sorted, 'none')
      expect(first).toEqual(second)
      expect(first[0].issues).not.toBe(second[0].issues)
      first[0].issues.pop()
      expect(second[0].issues).toEqual(sorted)
    }
    expect(groupSortedLinearIssues([], 'status')).toEqual([])
  })
})
