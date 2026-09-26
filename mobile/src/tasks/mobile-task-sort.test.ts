import { describe, expect, it, vi } from 'vitest'
import type { TaskItem } from './mobile-tasks-project-workspace-types'
import type { RepoSummary } from './mobile-tasks-provider-detail-types'
import { sortMobileTaskItems, taskRepositoryMeta } from './mobile-tasks-repository-presentation'
import { taskTime } from './mobile-tasks-item-mapping'

vi.mock('./mobile-tasks-dependencies', () => import('../theme/mobile-theme'))

function task(
  provider: TaskItem['provider'],
  label: string,
  updatedAt: string,
  key: string
): TaskItem {
  const source =
    provider === 'linear'
      ? { team: { id: label, name: label }, state: { color: '' } }
      : provider === 'gitlabTodo'
        ? { projectPath: label }
        : { repoId: label, repoName: label }
  return { provider, source, updatedAt, key, title: key, subtitle: '', status: '' } as TaskItem
}
const repos = new Map<string, RepoSummary>([
  ['alias', { id: 'alias', displayName: 'Álpha', path: '/repo' }]
])
const items = [
  task('github', 'alias', '2026-01-01', 'a'),
  task('gitlab', 'alpha', '2026-02-01', 'b'),
  task('gitlabTodo', 'Zeta', 'invalid', 'c'),
  task('linear', 'Älpha', '2026-02-01', 'd'),
  task('github', 'alpha', '2026-02-01', 'e'),
  task('linear', 'Zeta', '1970-01-01', 'f')
]

describe('mobile task sorting', () => {
  it.each(['repository', 'updated'] as const)(
    'preserves %s order, ties, fallbacks, and input identity',
    (sort) => {
      const compareBefore = (a: TaskItem, b: TaskItem) => {
        const labelOrder =
          sort === 'repository'
            ? taskRepositoryMeta(a, repos).label.localeCompare(
                taskRepositoryMeta(b, repos).label,
                undefined,
                { sensitivity: 'base' }
              )
            : 0
        return labelOrder || taskTime(b.updatedAt) - taskTime(a.updatedAt)
      }
      const expected = [...items].sort(compareBefore)
      const input = Object.freeze([...items])
      const actual = sortMobileTaskItems(input, sort, repos)
      expect(actual).toEqual(expected)
      actual.forEach((item, index) => expect(item).toBe(expected[index]))
      expect(input).toEqual(items)
      repos.set('alias', { id: 'alias', displayName: 'zzzz', path: '/repo' })
      try {
        expect(sortMobileTaskItems(input, sort, repos)).toEqual([...items].sort(compareBefore))
      } finally {
        repos.set('alias', { id: 'alias', displayName: 'Álpha', path: '/repo' })
      }
    }
  )

  it.each(['repository', 'updated'] as const)('computes %s keys only once per item', (sort) => {
    const parse = vi.spyOn(Date, 'parse')
    const getRepo = vi.spyOn(repos, 'get')
    const localeCompare = vi.spyOn(String.prototype, 'localeCompare')
    try {
      sortMobileTaskItems(items, sort, repos)
      expect(parse).toHaveBeenCalledTimes(items.length)
      expect(getRepo).toHaveBeenCalledTimes(sort === 'repository' ? 3 : 0)
      expect(localeCompare).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
      getRepo.mockRestore()
      localeCompare.mockRestore()
    }
  })

  it('skips setup for empty/singleton arrays while returning a fresh array', () => {
    const parse = vi.spyOn(Date, 'parse')
    const collator = vi.spyOn(Intl, 'Collator')
    try {
      expect(sortMobileTaskItems([], 'repository', repos)).toEqual([])
      const one = [items[0]]
      expect(sortMobileTaskItems(one, 'repository', repos)).toEqual(one)
      expect(sortMobileTaskItems(one, 'updated', repos)).not.toBe(one)
      expect(parse).not.toHaveBeenCalled()
      expect(collator).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
      collator.mockRestore()
    }
  })
})
