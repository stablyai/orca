import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ disconnect: vi.fn(), removeAllForwards: vi.fn() }))

vi.mock('./ssh-ipc-context', () => ({
  connectionManager: { disconnect: mocks.disconnect },
  portForwardManager: { removeAllForwards: mocks.removeAllForwards },
  persistedStore: null
}))
vi.mock('../../managed-server/lifecycle/orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnelsForTarget: vi.fn()
}))

const { releaseUnlinkedHostTransport } = await import('./ssh-session-teardown')
const {
  admittedConnectAuthority,
  connectInFlight,
  invalidateConnectAttempt,
  isCurrentConnectAttempt
} = await import('./ssh-connect-attempt-registry')
const { getSshProviderAuthority } = await import('../../ssh/ssh-provider-authority')

describe('releaseUnlinkedHostTransport (#37767)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectInFlight.clear()
  })

  it('hangs up the host and fences a connect already running past the unlink', async () => {
    const authority = getSshProviderAuthority('ssh-1')
    connectInFlight.set('ssh-1', { authority, promise: new Promise(() => {}) })
    await releaseUnlinkedHostTransport('ssh-1')
    expect(mocks.disconnect).toHaveBeenCalledWith('ssh-1')
    expect(isCurrentConnectAttempt('ssh-1', authority)).toBe(false)
  })

  it('fences the running connect but still admits a Connect queued behind the unlink', async () => {
    const running = getSshProviderAuthority('ssh-4')
    connectInFlight.set('ssh-4', { authority: running, promise: new Promise(() => {}) })
    // The queued Connect captured the same authority before waiting on the lifecycle.
    const queued = running
    await releaseUnlinkedHostTransport('ssh-4')
    expect(isCurrentConnectAttempt('ssh-4', running)).toBe(false)
    expect(admittedConnectAuthority('ssh-4', queued)).toEqual(getSshProviderAuthority('ssh-4'))
    // A later Disconnect still cancels it.
    invalidateConnectAttempt('ssh-4')
    expect(admittedConnectAuthority('ssh-4', queued)).toBeNull()
  })

  it('leaves a Connect queued behind the unlink free to run', async () => {
    const queued = getSshProviderAuthority('ssh-2')
    await releaseUnlinkedHostTransport('ssh-2')
    expect(mocks.disconnect).toHaveBeenCalledWith('ssh-2')
    expect(isCurrentConnectAttempt('ssh-2', queued)).toBe(true)
  })

  it('keeps the committed unlink when the hang-up fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.disconnect.mockRejectedValueOnce(new Error('socket gone'))
    await expect(releaseUnlinkedHostTransport('ssh-3')).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
