import { describe, expect, it, vi } from 'vitest'
import { persistWorktreeSortOrderSnapshot } from './worktree-sort-order-snapshot'

function createStore(sortOrders: Record<string, number | undefined>) {
  return {
    getWorktreeMeta: vi.fn((id: string) =>
      Object.hasOwn(sortOrders, id) ? { sortOrder: sortOrders[id] } : undefined
    ),
    setWorktreeMeta: vi.fn()
  }
}

describe('persistWorktreeSortOrderSnapshot', () => {
  it('skips writes when the persisted relative order already matches', () => {
    const store = createStore({ first: 3_000, second: 2_000, third: 1_000 })

    expect(persistWorktreeSortOrderSnapshot(store, ['first', 'second', 'third'], 10_000)).toBe(0)
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('writes a new strictly ordered snapshot when the relative order changes', () => {
    const store = createStore({ first: 1_000, second: 2_000, third: 3_000 })

    expect(persistWorktreeSortOrderSnapshot(store, ['first', 'second', 'third'], 10_000)).toBe(3)
    expect(store.setWorktreeMeta.mock.calls).toEqual([
      ['first', { sortOrder: 10_000 }],
      ['second', { sortOrder: 9_000 }],
      ['third', { sortOrder: 8_000 }]
    ])
  })

  it('writes tied legacy values once so the requested order is durable', () => {
    const store = createStore({ first: 0, second: 0 })

    expect(persistWorktreeSortOrderSnapshot(store, ['first', 'second'], 10_000)).toBe(2)
  })

  it('ignores stale ids without creating metadata', () => {
    const store = createStore({ first: 2_000, second: 1_000 })

    expect(persistWorktreeSortOrderSnapshot(store, ['first', 'stale', 'second'], 10_000)).toBe(0)
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })
})
