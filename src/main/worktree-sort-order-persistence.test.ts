import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../shared/types'
import { persistWorktreeSortOrder } from './worktree-sort-order-persistence'

function createReader(sortOrders: Record<string, number | undefined | 'absent'>) {
  const writes: { worktreeId: string; sortOrder: number | undefined }[] = []
  return {
    writes,
    getWorktreeMeta: (worktreeId: string) => {
      if (!(worktreeId in sortOrders) || sortOrders[worktreeId] === 'absent') {
        return undefined
      }
      return { sortOrder: sortOrders[worktreeId] } as WorktreeMeta
    },
    setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
      writes.push({ worktreeId, sortOrder: meta.sortOrder })
      return { sortOrder: meta.sortOrder } as WorktreeMeta
    }
  }
}

describe('worktree sort order persistence', () => {
  it('skips an order already represented by strictly descending persisted ranks', () => {
    const store = createReader({ first: 3000, second: 2000, third: 1000 })

    expect(persistWorktreeSortOrder(store, ['first', 'second', 'third'], 9000)).toBe(0)
    expect(store.writes).toEqual([])
  })

  it.each([
    ['changed order', { first: 3000, second: 1000, third: 2000 }, ['first', 'second', 'third'], 3],
    ['missing rank on existing meta', { first: 3000, second: undefined }, ['first', 'second'], 2],
    ['tied ranks', { first: 3000, second: 3000 }, ['first', 'second'], 2],
    ['duplicate id', { first: 3000 }, ['first', 'first'], 2]
  ] as const)('persists %s', (_label, sortOrders, orderedIds, expectedWrites) => {
    const store = createReader(sortOrders as Record<string, number | undefined>)

    expect(persistWorktreeSortOrder(store, orderedIds, 9000)).toBe(expectedWrites)
    expect(store.writes).toHaveLength(expectedWrites)
  })

  it('does not mint worktreeMeta for unknown ids (#9342)', () => {
    // first/second inverted so a rewrite is required; ghost must still be skipped.
    const store = createReader({ first: 1000, second: 2000, ghost: 'absent' })

    expect(persistWorktreeSortOrder(store, ['first', 'ghost', 'second'], 9000)).toBe(2)
    expect(store.writes.map(({ worktreeId }) => worktreeId)).toEqual(['first', 'second'])
  })

  it('writes changed ranks in strict descending order', () => {
    const store = createReader({ first: 1000, second: 2000 })

    expect(persistWorktreeSortOrder(store, ['first', 'second'], 9000)).toBe(2)
    expect(store.writes).toEqual([
      { worktreeId: 'first', sortOrder: 9000 },
      { worktreeId: 'second', sortOrder: 8000 }
    ])
  })
})
