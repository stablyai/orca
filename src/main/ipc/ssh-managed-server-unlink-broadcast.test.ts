import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  notify: vi.fn(),
  getState: vi.fn()
}))

vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getState: mocks.getState },
  currentRuntime: { notifySshStateChanged: mocks.notify },
  getCurrentMainWindow: () => ({ isDestroyed: () => false, webContents: { send: mocks.send } }),
  persistedStore: null,
  portForwardManager: null
}))
vi.mock('../ssh/ssh-target-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSshTargetRegistryStore: () => null
}))

const { clearPublishedManagedServer } = await import('./ssh-renderer-broadcast')
const { getSshHostServerStatus, setSshHostServerStatus } =
  await import('../ssh/ssh-host-server-status')

describe('clearing a host’s managed server once it is unlinked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('forgets the environment and republishes the connection without it', () => {
    setSshHostServerStatus('ssh-1', { kind: 'managed', environmentId: 'env-1' })
    mocks.getState.mockReturnValue({
      targetId: 'ssh-1',
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    clearPublishedManagedServer('ssh-1')
    expect(getSshHostServerStatus('ssh-1')).toBeUndefined()
    // The runtime's notify is what drops the host's cached worktree scans.
    const [, published] = mocks.notify.mock.calls[0] ?? []
    expect(published).toMatchObject({ targetId: 'ssh-1', status: 'connected' })
    expect(published).not.toHaveProperty('managedServer')
    expect(mocks.send).toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.objectContaining({ targetId: 'ssh-1' })
    )
  })

  it('only clears when the host has no connection to republish', () => {
    setSshHostServerStatus('ssh-1', { kind: 'managed', environmentId: 'env-1' })
    mocks.getState.mockReturnValue(undefined)
    clearPublishedManagedServer('ssh-1')
    expect(getSshHostServerStatus('ssh-1')).toBeUndefined()
    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
