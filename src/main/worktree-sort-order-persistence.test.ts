import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../shared/types'
import { persistWorktreeSortOrder } from './worktree-sort-order-persistence'

function createReader(sortOrders: Record<string, number | undefined>) {
  const writes: { worktreeId: string; sortOrder: number | undefined }[] = []
  return {
    writes,
    getWorktreeMeta: (worktreeId: string) =>
      sortOrders[worktreeId] === undefined
        ? undefined
        : ({ sortOrder: sortOrders[worktreeId] } as WorktreeMeta),
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
    ['changed order', { first: 3000, second: 1000, third: 2000 }, ['first', 'second', 'third']],
    ['missing rank', { first: 3000, second: undefined }, ['first', 'second']],
    ['tied ranks', { first: 3000, second: 3000 }, ['first', 'second']],
    ['duplicate id', { first: 3000 }, ['first', 'first']]
  ])('persists %s', (_label, sortOrders, orderedIds) => {
    const store = createReader(sortOrders)

    expect(persistWorktreeSortOrder(store, orderedIds, 9000)).toBe(orderedIds.length)
    expect(store.writes.map(({ worktreeId }) => worktreeId)).toEqual(orderedIds)
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
