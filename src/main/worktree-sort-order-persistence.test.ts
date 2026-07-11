import { describe, expect, it, vi } from 'vitest'
import { persistWorktreeSortOrderIfChanged } from './worktree-sort-order-persistence'

function makeStore(entries: readonly (readonly [string, number])[] = []) {
  const metadata = new Map(entries.map(([id, sortOrder]) => [id, { sortOrder }]))
  return {
    getWorktreeMeta: vi.fn((worktreeId: string) => metadata.get(worktreeId)),
    setWorktreeMeta: vi.fn()
  }
}

describe('persistWorktreeSortOrderIfChanged', () => {
  it('keeps empty input without metadata reads or writes', () => {
    const store = makeStore()

    expect(persistWorktreeSortOrderIfChanged(store, [])).toEqual({ updated: 0 })
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps a singleton with a finite sort order without writes', () => {
    const store = makeStore([['first', 42.5]])

    expect(persistWorktreeSortOrderIfChanged(store, ['first'])).toEqual({ updated: 0 })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps strictly descending finite values with arbitrary gaps', () => {
    const store = makeStore([
      ['first', 9000],
      ['second', 8999],
      ['third', 100]
    ])

    expect(persistWorktreeSortOrderIfChanged(store, ['first', 'second', 'third'])).toEqual({
      updated: 0
    })
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it.each([
    {
      label: 'missing',
      entries: [['first', 3000]] as const
    },
    {
      label: 'tied',
      entries: [
        ['first', 3000],
        ['second', 3000]
      ] as const
    },
    {
      label: 'non-finite',
      entries: [
        ['first', Number.NaN],
        ['second', 2000]
      ] as const
    },
    {
      label: 'non-descending',
      entries: [
        ['first', 1000],
        ['second', 2000]
      ] as const
    }
  ])('rewrites every requested ID for $label values', ({ entries }) => {
    const store = makeStore(entries)

    expect(persistWorktreeSortOrderIfChanged(store, ['first', 'second'], 8000)).toEqual({
      updated: 2
    })
    expect(store.setWorktreeMeta.mock.calls.map(([worktreeId]) => worktreeId)).toEqual([
      'first',
      'second'
    ])
  })

  it('ignores metadata outside the requested IDs', () => {
    const store = makeStore([
      ['first', 5000],
      ['second', 4500],
      ['unrelated', Number.NaN]
    ])

    expect(persistWorktreeSortOrderIfChanged(store, ['first', 'second'])).toEqual({ updated: 0 })
    expect(store.getWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(store.getWorktreeMeta).not.toHaveBeenCalledWith('unrelated')
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('writes descending timestamps from an injected clock', () => {
    const store = makeStore()

    expect(persistWorktreeSortOrderIfChanged(store, ['first', 'second'], 5000)).toEqual({
      updated: 2
    })
    expect(store.setWorktreeMeta).toHaveBeenNthCalledWith(1, 'first', { sortOrder: 5000 })
    expect(store.setWorktreeMeta).toHaveBeenNthCalledWith(2, 'second', { sortOrder: 4000 })
    expect(store.setWorktreeMeta).toHaveBeenCalledTimes(2)
  })
})
