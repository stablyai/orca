import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  restore: vi.fn(async () => {}),
  removeAllForwards: vi.fn(async () => {}),
  closeManagedTunnels: vi.fn(async () => {}),
  disconnect: vi.fn(async () => {}),
  getState: vi.fn(() => ({ targetId: 't1', status: 'connected', error: null, reconnectAttempt: 0 }))
}))

vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: vi.fn(async () => {}),
  closeOrcadManagedTunnelsForTarget: h.closeManagedTunnels
}))
vi.mock('./ssh-managed-port-forward-restore', () => ({ restoreManagedHostPortForwards: h.restore }))
vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { getState: h.getState, disconnect: h.disconnect, getConnection: vi.fn() },
  currentRuntime: null,
  getCurrentMainWindow: () => null,
  persistedStore: null,
  portForwardManager: { removeAllForwards: h.removeAllForwards }
}))
vi.mock('../../ssh/targets/ssh-target-registry', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSshTargetRegistryStore: () => null
}))

const { handleSshConnectionStateChange } = await import('./ssh-connection-state-callbacks')
const { publishManagedServerConnect } = await import('./ssh-host-server-connect')
const { disconnectRegisteredSshTarget } = await import('./ssh-session-teardown')
const { connectInFlight } = await import('./ssh-connect-attempt-registry')
const { getSshProviderAuthority } = await import('../../ssh/ssh-provider-authority')
const { clearSshHostServerStatus, setSshHostServerStatus } =
  await import('../../ssh/ssh-host-server-status')

const connected = { targetId: 't1', status: 'connected', error: null, reconnectAttempt: 0 } as const

describe('saved port forwards on a managed host', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearSshHostServerStatus('t1')
  })

  it('restores them when a managed connect is published', () => {
    publishManagedServerConnect('t1', 'env-1')
    expect(h.restore).toHaveBeenCalledWith('t1')
  })

  it('restores them when the managed host transport reconnects on its own', () => {
    setSshHostServerStatus('t1', { kind: 'managed', environmentId: 'env-1' })
    handleSshConnectionStateChange('t1', { ...connected, status: 'reconnecting' })
    expect(h.restore).not.toHaveBeenCalled()
    handleSshConnectionStateChange('t1', connected)
    expect(h.restore).toHaveBeenCalledWith('t1')
  })

  it('leaves an explicit connect to restore through its own publish', () => {
    connectInFlight.set('t1', {
      authority: getSshProviderAuthority('t1'),
      promise: new Promise(() => {})
    })
    try {
      handleSshConnectionStateChange('t1', connected)
      expect(h.restore).not.toHaveBeenCalled()
    } finally {
      connectInFlight.delete('t1')
    }
  })

  it('closes the local listeners on disconnect even though no relay session exists', async () => {
    await disconnectRegisteredSshTarget('t1')
    expect(h.removeAllForwards).toHaveBeenCalledWith('t1')
  })

  // Managed system-SSH tunnels run separate ssh -L processes; session disconnect alone leaves them alive.
  it('closes the managed server tunnels the session carried', async () => {
    await disconnectRegisteredSshTarget('t1')
    expect(h.closeManagedTunnels).toHaveBeenCalledWith('t1')
  })
})
