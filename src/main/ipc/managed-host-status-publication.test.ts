import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn(), notify: vi.fn(), getState: vi.fn() }))

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

const { clearManagedServerNotes, publishHostServerStatus } =
  await import('./runtime-environment-managed-tunnel')
const { getPublicSshState, relayStateOverrides } = await import('./ssh-renderer-broadcast')
const { clearSshHostServerStatus, getSshHostServerStatus, setSshHostServerStatus } =
  await import('../ssh/ssh-host-server-status')

const ready = { kind: 'managed', environmentId: 'env-1' } as const
const deferred = {
  ...ready,
  update: { state: 'deferred', detail: 'A terminal is still running.' }
} as const

function connection(status: 'connected' | 'disconnected') {
  return { targetId: 'ssh-1', status, error: null, reconnectAttempt: 0, managedServer: deferred }
}

describe('publishing a verified managed host status', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    relayStateOverrides.clear()
    clearSshHostServerStatus('ssh-1')
    clearSshHostServerStatus('ssh-2')
  })

  it('replaces the deferred diagnostic in the host store and both subscribers', () => {
    setSshHostServerStatus('ssh-1', deferred)
    mocks.getState.mockReturnValue(connection('connected'))
    publishHostServerStatus('ssh-1', ready)
    expect(getSshHostServerStatus('ssh-1')).toEqual(ready)
    expect(mocks.notify).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({ managedServer: ready })
    )
    expect(mocks.send).toHaveBeenCalledWith(
      'ssh:state-changed',
      expect.objectContaining({ state: expect.objectContaining({ managedServer: ready }) })
    )
  })

  it('refreshes a retained override so later reads also forget the deferral', () => {
    relayStateOverrides.set('ssh-1', connection('connected'))
    publishHostServerStatus('ssh-1', ready)
    expect(relayStateOverrides.get('ssh-1')?.managedServer).toEqual(ready)
    expect(getPublicSshState('ssh-1')?.managedServer).toEqual(ready)
  })

  it('preserves disconnected contact instead of inventing a connection', () => {
    mocks.getState.mockReturnValue(connection('disconnected'))
    publishHostServerStatus('ssh-1', ready)
    expect(mocks.notify).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({ status: 'disconnected', managedServer: ready })
    )
  })

  it('retains the current unverifiable host evidence when publishing it', () => {
    mocks.getState.mockReturnValue(connection('connected'))
    const unverifiable = {
      ...ready,
      serving: { state: 'unverifiable', detail: 'The process is live but not answering.' }
    } as const
    publishHostServerStatus('ssh-1', unverifiable)
    expect(getSshHostServerStatus('ssh-1')).toEqual(unverifiable)
    expect(mocks.notify.mock.calls[0]?.[1].managedServer).toEqual(unverifiable)
  })

  it('records a host without a connection and leaves another host untouched', () => {
    mocks.getState.mockReturnValue(undefined)
    setSshHostServerStatus('ssh-2', deferred)
    publishHostServerStatus('ssh-1', ready)
    expect(getSshHostServerStatus('ssh-1')).toEqual(ready)
    expect(getSshHostServerStatus('ssh-2')).toEqual(deferred)
    expect(mocks.notify).not.toHaveBeenCalled()
    expect(mocks.send).not.toHaveBeenCalled()
  })

  it("clears a verified host's deferral and unverifiable notes", () => {
    mocks.getState.mockReturnValue(connection('connected'))
    setSshHostServerStatus('ssh-1', {
      ...deferred,
      serving: { state: 'unverifiable', detail: 'No reply.' }
    })
    clearManagedServerNotes('ssh-1', 'env-1')
    expect(getSshHostServerStatus('ssh-1')).toEqual(ready)
    expect(mocks.notify).toHaveBeenCalledWith(
      'ssh-1',
      expect.objectContaining({ managedServer: ready })
    )
  })

  it('leaves a relay route, another server, or an unknown host as it was', () => {
    mocks.getState.mockReturnValue(connection('connected'))
    const relay = { kind: 'relay', reason: 'source_changed' } as const
    setSshHostServerStatus('ssh-1', relay)
    clearManagedServerNotes('ssh-1', 'env-1')
    expect(getSshHostServerStatus('ssh-1')).toEqual(relay)
    setSshHostServerStatus('ssh-1', { ...deferred, environmentId: 'env-2' })
    clearManagedServerNotes('ssh-1', 'env-1')
    expect(getSshHostServerStatus('ssh-1')).toMatchObject({ environmentId: 'env-2' })
    clearManagedServerNotes('ssh-2', 'env-1')
    expect(getSshHostServerStatus('ssh-2')).toBeUndefined()
    expect(mocks.notify).not.toHaveBeenCalled()
  })
})
