import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  removeHandler: vi.fn(),
  getManagedAgentHookStatuses: vi.fn()
}))

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle, removeHandler: mocks.removeHandler }
}))

vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  getManagedAgentHookStatuses: mocks.getManagedAgentHookStatuses
}))

import {
  registerAgentHookInstallStatusIpc,
  removeAgentHookInstallStatusIpc
} from './agent-hook-install-status-ipc'

describe('agent hook install status IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns one aggregate snapshot from the managed registry', () => {
    const statuses = [{ agent: 'claude', state: 'installed' }]
    mocks.getManagedAgentHookStatuses.mockReturnValue(statuses)

    registerAgentHookInstallStatusIpc()

    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'agentHooks:installStatuses'
    )?.[1]
    expect(handler?.()).toBe(statuses)
  })

  it('removes the aggregate handler before re-registration', () => {
    removeAgentHookInstallStatusIpc()

    expect(mocks.removeHandler).toHaveBeenCalledWith('agentHooks:installStatuses')
  })

  it('rejects an aggregate failure so the renderer retains its last snapshot', () => {
    const error = new Error('status read failed')
    mocks.getManagedAgentHookStatuses.mockImplementation(() => {
      throw error
    })
    registerAgentHookInstallStatusIpc()
    const handler = mocks.handle.mock.calls[0]?.[1]

    expect(() => handler?.()).toThrow(error)
  })
})
