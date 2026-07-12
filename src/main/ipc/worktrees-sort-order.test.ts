import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, removeHandlerMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: handleMock,
    removeHandler: removeHandlerMock
  }
}))

import { registerWorktreeHandlers } from './worktrees'

type PersistSortOrderHandler = (event: unknown, args: { orderedIds: string[] }) => unknown

function getPersistSortOrderHandler(): PersistSortOrderHandler {
  const registration = handleMock.mock.calls.find(
    ([channel]) => channel === 'worktrees:persistSortOrder'
  )
  expect(registration).toBeDefined()
  return registration?.[1] as PersistSortOrderHandler
}

function registerWithMetadata(entries: readonly (readonly [string, number])[]) {
  const metadata = new Map(entries.map(([id, sortOrder]) => [id, { sortOrder }]))
  const store = {
    getWorktreeMeta: vi.fn((worktreeId: string) => metadata.get(worktreeId)),
    setWorktreeMeta: vi.fn()
  }
  registerWorktreeHandlers({} as never, store as never, {} as never)
  return { handler: getPersistSortOrderHandler(), store }
}

describe('worktrees:persistSortOrder', () => {
  beforeEach(() => {
    handleMock.mockClear()
    removeHandlerMock.mockClear()
  })

  it('keeps an unchanged finite descending order without metadata writes', () => {
    const { handler, store } = registerWithMetadata([
      ['first', 5000],
      ['second', 4000]
    ])

    const result = handler(null, { orderedIds: ['first', 'second'] })

    expect(result).toBeUndefined()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })

  it('keeps empty input as a void early return without metadata reads or writes', () => {
    const { handler, store } = registerWithMetadata([])

    const result = handler(null, { orderedIds: [] })

    expect(result).toBeUndefined()
    expect(store.getWorktreeMeta).not.toHaveBeenCalled()
    expect(store.setWorktreeMeta).not.toHaveBeenCalled()
  })
})
