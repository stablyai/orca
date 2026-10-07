import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  update: vi.fn(),
  rollback: vi.fn(),
  recover: vi.fn(),
  stop: vi.fn(),
  cancel: vi.fn(),
  retire: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../ssh/orcad-runtime-lifecycle', () => ({
  updateManagedOrcadEnvironment: mocks.update,
  rollbackManagedOrcadEnvironment: mocks.rollback,
  recoverManagedOrcadEnvironment: mocks.recover,
  stopManagedOrcadEnvironment: mocks.stop,
  cancelManagedOrcadStop: mocks.cancel
}))
vi.mock('./runtime-environment-removal-cleanup', () => ({
  retireRemovedRuntimeEnvironment: mocks.retire
}))

const { registerOrcadRuntimeMaintenanceHandlers } =
  await import('./orcad-runtime-maintenance-handlers')

const invalidateTransport = vi.fn()
const clearHostServerStatus = vi.fn()
const forgetHostSession = vi.fn()

function handler(channel: string): (_event: unknown, args: unknown) => Promise<unknown> {
  const registration = mocks.handle.mock.calls.find(([name]) => name === channel)
  if (!registration) {
    throw new Error(`${channel} handler was not registered`)
  }
  return registration[1]
}

describe('managed orcad maintenance IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerOrcadRuntimeMaintenanceHandlers({
      getUserDataPath: () => '/profile',
      getActiveEnvironmentId: () => 'active-environment',
      invalidateTransport,
      clearHostServerStatus,
      forgetHostSession
    })
  })

  it('reconnects after an update restarts orcad, but not after a deferral', async () => {
    mocks.update.mockResolvedValueOnce({ outcome: 'deferred', code: 'busy' })
    await handler('runtimeEnvironments:updateOrcad')(null, { selector: 'Managed', force: 'yes' })
    expect(mocks.update).toHaveBeenCalledWith('/profile', { selector: 'Managed', force: false })
    expect(invalidateTransport).not.toHaveBeenCalled()
    mocks.update.mockResolvedValueOnce({ outcome: 'updated', environment: { id: 'e-1' } })
    await handler('runtimeEnvironments:updateOrcad')(null, { selector: 'Managed', force: true })
    expect(invalidateTransport).toHaveBeenCalledWith('e-1')
  })

  it('reconnects after rollback and after recovery restores a serving slot', async () => {
    mocks.rollback.mockResolvedValueOnce({ outcome: 'rolled-back', environment: { id: 'e-1' } })
    await handler('runtimeEnvironments:rollbackOrcad')(null, { selector: 'Managed' })
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      activeVersion: null,
      environment: { id: 'e-1' }
    })
    await handler('runtimeEnvironments:recoverOrcad')(null, { selector: 'Managed' })
    expect(invalidateTransport).toHaveBeenCalledTimes(1)
  })

  it('stops with the Active Server guard and the shared removal cleanup', async () => {
    mocks.stop.mockResolvedValueOnce({ outcome: 'unlinked', sshTargetId: 'ssh-1' })
    await handler('runtimeEnvironments:stopOrcad')(null, { selector: ' Managed ' })
    const [, args, policy] = mocks.stop.mock.calls[0] ?? []
    expect(args).toEqual({ selector: 'Managed' })
    expect(policy.isActiveEnvironment('active-environment')).toBe(true)
    expect(policy.isActiveEnvironment('e-1')).toBe(false)
    policy.retireLocalState('e-1')
    expect(mocks.retire).toHaveBeenCalledWith('e-1', invalidateTransport, forgetHostSession)
    // The SSH host stops naming the unlinked server without waiting for a reconnect.
    expect(clearHostServerStatus).toHaveBeenCalledWith('ssh-1')
  })

  it('keeps the SSH host’s managed state when the stop is refused', async () => {
    mocks.stop.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'live',
      code: 'c',
      reason: 'r'
    })
    await handler('runtimeEnvironments:stopOrcad')(null, { selector: 'Managed' })
    expect(clearHostServerStatus).not.toHaveBeenCalled()
  })

  it('rejects a missing selector before touching SSH', async () => {
    await expect(handler('runtimeEnvironments:cancelOrcadStop')(null, {})).rejects.toThrow(
      'Server is required'
    )
    expect(mocks.cancel).not.toHaveBeenCalled()
  })
})
