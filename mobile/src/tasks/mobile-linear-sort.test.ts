import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LinearIssue } from './mobile-tasks-provider-detail-types'
import type { LinearOrderBy } from './mobile-tasks-view-state-types'
import { groupLinearIssues, sortLinearIssues } from './mobile-tasks-reviewer-linear'
import { taskTime } from './mobile-tasks-item-mapping'
import { getLinearPriorityRank } from './mobile-tasks-hosted-review'

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
function originalSort(input: readonly LinearIssue[], mode: LinearOrderBy): LinearIssue[] {
  return [...input].sort((a, b) => {
    if (mode === 'updated') {
      return taskTime(b.updatedAt) - taskTime(a.updatedAt)
    }
    if (mode === 'identifier') {
      return a.identifier.localeCompare(b.identifier, undefined, { numeric: true })
    }
    return (
      getLinearPriorityRank(a.priority) - getLinearPriorityRank(b.priority) ||
      taskTime(b.updatedAt) - taskTime(a.updatedAt)
    )
  })
}

describe('mobile Linear sorting', () => {
  it.each(['updated', 'identifier', 'priority'] as const)(
    'preserves %s ordering and stable ties',
    (mode) => {
      const input = Object.freeze([...issues])
      const expected = originalSort(input, mode)
      const actual = sortLinearIssues(input, mode)
      expect(actual).toEqual(expected)
      actual.forEach((issue, index) => expect(issue).toBe(expected[index]))
      expect(input).toEqual(issues)
      for (const groupBy of ['none', 'status', 'priority', 'team', 'assignee'] as const) {
        const groups = groupLinearIssues([...input], groupBy, mode)
        for (const group of groups) {
          expect(group.issues).toEqual(expected.filter((issue) => group.issues.includes(issue)))
        }
        expect(groups.flatMap((group) => group.issues)).toHaveLength(input.length)
      }
    }
  )

  it.each(['updated', 'identifier', 'priority'] as const)('bounds %s setup to one pass', (mode) => {
    const parse = vi.spyOn(Date, 'parse')
    const NativeCollator = Intl.Collator
    const collator = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })
    const compare = vi.spyOn(String.prototype, 'localeCompare')
    sortLinearIssues(issues, mode)
    expect(parse).toHaveBeenCalledTimes(mode === 'identifier' ? 0 : issues.length)
    expect(collator).toHaveBeenCalledTimes(mode === 'identifier' ? 1 : 0)
    expect(compare).not.toHaveBeenCalled()
  })

  it('skips setup for empty and singleton inputs and returns fresh arrays', () => {
    const parse = vi.spyOn(Date, 'parse')
    const NativeCollator = Intl.Collator
    const collator = vi.spyOn(Intl, 'Collator').mockImplementation(function (locales, options) {
      return new NativeCollator(locales, options)
    })
    for (const mode of ['updated', 'identifier', 'priority'] as const) {
      for (const input of [[], [issues[0]]]) {
        const actual = sortLinearIssues(input, mode)
        expect(actual).toEqual(input)
        expect(actual).not.toBe(input)
      }
    }
    expect(parse).not.toHaveBeenCalled()
    expect(collator).not.toHaveBeenCalled()
  })
})
