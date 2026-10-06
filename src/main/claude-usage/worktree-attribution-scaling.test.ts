import { expect, it, vi } from 'vitest'
import { attributeClaudeUsageTurns } from './worktree-attribution'
import type { ClaudeUsageParsedTurn } from './types'

vi.mock('node:fs/promises', () => ({ realpath: async (path: string) => path }))

it('resolves repeated nested and unmatched cwd paths once per attribution batch', async () => {
  const lookup = new Map(
    Array.from({ length: 100 }, (_, index) => [
      `/repo-${String(index).padStart(3, '0')}`,
      {
        repoId: `repo-${index}`,
        worktreeId: `wt-${index}`,
        path: `/repo-${index}`,
        displayName: `Repo ${index}`
      }
    ])
  )
  const input: ClaudeUsageParsedTurn[] = Array.from({ length: 1000 }, (_, index) => ({
    sessionId: String(index),
    timestamp: '2026-09-07T00:00:00Z',
    model: null,
    cwd: index % 2 === 0 ? '/repo-099/nested' : '/outside',
    gitBranch: null,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheWrite1hTokens: 0
  }))
  const original = String.prototype.startsWith
  let comparisons = 0
  const spy = vi.spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number
  ) {
    if (search.slice(0, 6) === '/repo-') {
      comparisons += 1
    }
    return original.call(this, search, position)
  })
  let result: Awaited<ReturnType<typeof attributeClaudeUsageTurns>>
  try {
    result = await attributeClaudeUsageTurns(input, lookup)
  } finally {
    spy.mockRestore()
  }
  expect(comparisons).toBeLessThanOrEqual(200)
  expect(result![0].worktreeId).toBe('wt-99')
  expect(result![1].worktreeId).toBeNull()
  expect(result![1].projectKey).toBe('cwd:/outside')
})
