import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, onMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: handleMock, on: onMock }
}))

import { registerSessionHandlers } from './session'

describe('registerSessionHandlers', () => {
  beforeEach(() => {
    handleMock.mockClear()
    onMock.mockClear()
  })

  it('routes authoritative SSH partition enumeration through the store', () => {
    const expected = { tabsByWorktree: {} }
    const store = {
      adoptSshWorkspaceSessionPartition: vi.fn(() => expected)
    }
    registerSessionHandlers(store as never)
    const handler = handleMock.mock.calls.find(
      ([channel]) => channel === 'session:adopt-ssh-partition'
    )?.[1] as (event: unknown, hostId?: string) => unknown

    expect(handler({})).toBe(expected)
    expect(handler({}, 'ssh:target-1')).toBe(expected)
    expect(store.adoptSshWorkspaceSessionPartition.mock.calls).toEqual([
      [undefined],
      ['ssh:target-1']
    ])
  })
})
