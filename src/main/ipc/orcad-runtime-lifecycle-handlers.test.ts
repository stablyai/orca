import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  clearBrowserStorage: vi.fn(),
  cancelManaged: vi.fn(),
  forgetConnectivity: vi.fn(),
  handle: vi.fn(),
  listPendingManaged: vi.fn(),
  preflightManaged: vi.fn(),
  recoverManaged: vi.fn(),
  resolveEnvironment: vi.fn(),
  stopManaged: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: mocks.resolveEnvironment
}))
vi.mock('../browser/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: mocks.clearBrowserStorage
}))
vi.mock('./runtime-environment-connectivity-handlers', () => ({
  forgetRuntimeEnvironmentConnectivityState: mocks.forgetConnectivity
}))
vi.mock('../ssh/orcad-runtime-lifecycle', () => ({
  cancelManagedOrcadStop: mocks.cancelManaged,
  createManagedOrcadEnvironment: vi.fn(),
  getManagedOrcadRuntimeStatus: vi.fn(),
  listPendingManagedOrcadMigrations: mocks.listPendingManaged,
  preflightManagedOrcadTarget: mocks.preflightManaged,
  recoverManagedOrcadEnvironment: mocks.recoverManaged,
  rollbackManagedOrcadEnvironment: vi.fn(),
  stopManagedOrcadEnvironment: mocks.stopManaged,
  updateManagedOrcadEnvironment: vi.fn()
}))

const { registerOrcadRuntimeLifecycleHandlers } = await import('./orcad-runtime-lifecycle-handlers')

const environment = {
  id: 'environment-1',
  name: 'Managed server',
  orcadDeployment: { sshTargetId: 'ssh-1' }
}

function stopHandler() {
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'runtimeEnvironments:stopOrcad'
  )
  if (!registration) {
    throw new Error('stopOrcad handler was not registered')
  }
  return registration[1] as (_event: unknown, args: { selector: string }) => Promise<unknown>
}

function recoverHandler() {
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'runtimeEnvironments:recoverOrcad'
  )
  if (!registration) {
    throw new Error('recoverOrcad handler was not registered')
  }
  return registration[1] as (_event: unknown, args: { selector: string }) => Promise<unknown>
}

function preflightHandler() {
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'runtimeEnvironments:preflightOrcadTarget'
  )
  if (!registration) {
    throw new Error('preflightOrcadTarget handler was not registered')
  }
  return registration[1] as (_event: unknown, args: { sshTargetId: string }) => unknown
}

function listPendingHandler() {
  const registration = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'runtimeEnvironments:listPendingOrcadMigrations'
  )
  if (!registration) {
    throw new Error('listPendingOrcadMigrations handler was not registered')
  }
  return registration[1] as () => unknown
}

function register(activeEnvironmentId: string | null = null) {
  const invalidateTransport = vi.fn().mockResolvedValue(undefined)
  registerOrcadRuntimeLifecycleHandlers({
    getUserDataPath: () => '/user-data',
    getActiveEnvironmentId: () => activeEnvironmentId,
    invalidateTransport
  })
  return { handler: stopHandler(), invalidateTransport }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolveEnvironment.mockReturnValue(environment)
  mocks.clearBrowserStorage.mockResolvedValue(undefined)
})

describe('managed orcad stop IPC', () => {
  it('cancels explicitly without stopping, unlinking or invalidating the active server', async () => {
    const { invalidateTransport } = register(environment.id)
    const handler = mocks.handle.mock.calls.find(
      ([channel]) => channel === 'runtimeEnvironments:cancelOrcadStop'
    )![1]
    const result = { outcome: 'canceled', transactionId: 'original', activeVersion: '0.1.0' }
    mocks.cancelManaged.mockResolvedValue(result)
    expect(await handler(null, { selector: ' environment-1 ' })).toBe(result)
    expect(mocks.cancelManaged).toHaveBeenCalledWith('/user-data', { selector: 'environment-1' })
    expect(mocks.stopManaged).not.toHaveBeenCalled()
    expect(mocks.recoverManaged).not.toHaveBeenCalled()
    expect(invalidateTransport).not.toHaveBeenCalled()
    expect(mocks.clearBrowserStorage).not.toHaveBeenCalled()
    expect(() => handler(null, { selector: ' ' })).toThrow('Server is required')
  })

  it('refuses to stop the Active Server before invoking host lifecycle work', async () => {
    const { handler } = register(environment.id)

    await expect(handler(null, { selector: environment.id })).rejects.toThrow(
      'Choose another Active Server in Advanced'
    )
    expect(mocks.stopManaged).not.toHaveBeenCalled()
  })

  it('clears connectivity and browser partitions after successful unlink', async () => {
    mocks.stopManaged.mockImplementationOnce(async (_path, _args, options) => {
      await options.cleanupLocalState(environment.id)
      return {
        outcome: 'unlinked',
        verdict: 'exited',
        environment,
        sshTargetId: 'ssh-1',
        activeVersion: '0.2.0+new'
      }
    })
    const { handler, invalidateTransport } = register()

    await expect(handler(null, { selector: environment.id })).resolves.toMatchObject({
      outcome: 'unlinked'
    })
    expect(mocks.stopManaged).toHaveBeenCalledWith(
      '/user-data',
      { selector: environment.id },
      {
        invalidateTransport,
        isActiveEnvironment: expect.any(Function),
        cleanupLocalState: expect.any(Function)
      }
    )
    expect(mocks.forgetConnectivity).toHaveBeenCalledWith(environment.id)
    expect(mocks.clearBrowserStorage).toHaveBeenCalledWith(environment.id)
  })

  it('preserves connectivity and browser storage when host stop is refused', async () => {
    mocks.stopManaged.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_live_sessions',
      reason: 'A terminal is live.'
    })
    const { handler } = register()

    await expect(handler(null, { selector: environment.id })).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live'
    })
    expect(mocks.forgetConnectivity).not.toHaveBeenCalled()
    expect(mocks.clearBrowserStorage).not.toHaveBeenCalled()
  })
})

describe('managed orcad migration preflight IPC', () => {
  it('exposes restart-visible source journals without starting remote work', () => {
    mocks.listPendingManaged.mockReturnValueOnce([
      {
        environmentId: 'environment-1',
        name: 'Managed server',
        sshTargetId: 'ssh-1',
        sshTargetLabel: 'Build host',
        phase: 'source-fenced',
        startedAt: '2026-08-30T00:00:00.000Z'
      }
    ])
    register()

    expect(listPendingHandler()()).toEqual([
      expect.objectContaining({ environmentId: 'environment-1', phase: 'source-fenced' })
    ])
    expect(mocks.listPendingManaged).toHaveBeenCalledWith('/user-data')
    expect(mocks.stopManaged).not.toHaveBeenCalled()
  })

  it('returns the structured local ownership inventory without starting lifecycle work', () => {
    mocks.preflightManaged.mockReturnValueOnce({
      targetId: 'ssh-1',
      targetLabel: 'Build host',
      claimable: false,
      blockers: [
        {
          code: 'orcad_migration_direct_ssh_terminal_leases',
          category: 'live-or-unverifiable',
          terminalLeases: [{ ptyId: 'pty-1', state: 'detached', updatedAt: 42 }]
        }
      ]
    })
    register()

    expect(preflightHandler()(null, { sshTargetId: ' ssh-1 ' })).toMatchObject({
      targetId: 'ssh-1',
      claimable: false
    })
    expect(mocks.preflightManaged).toHaveBeenCalledWith('ssh-1')
    expect(mocks.stopManaged).not.toHaveBeenCalled()
  })
})

describe('managed orcad recovery IPC', () => {
  it('supplies the current active selection rather than a snapshot to recovery', async () => {
    let activeId: string | null = null
    registerOrcadRuntimeLifecycleHandlers({
      getUserDataPath: () => '/user-data',
      getActiveEnvironmentId: () => activeId,
      invalidateTransport: vi.fn()
    })
    mocks.recoverManaged.mockImplementationOnce(async (_path, _args, policy) => {
      expect(policy.isActiveEnvironment(environment.id)).toBe(false)
      activeId = environment.id
      expect(policy.isActiveEnvironment(environment.id)).toBe(true)
      expect(policy.isActiveEnvironment('other')).toBe(false)
      return { outcome: 'none' }
    })
    expect(await recoverHandler()(null, { selector: environment.id })).toEqual({ outcome: 'none' })
  })

  it('invalidates the old runtime transport after recovery', async () => {
    mocks.recoverManaged.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: '0.2.0+new',
      environment
    })
    const { invalidateTransport } = register()
    const handler = recoverHandler()

    await expect(handler(null, { selector: environment.id })).resolves.toMatchObject({
      outcome: 'recovered'
    })
    expect(mocks.recoverManaged).toHaveBeenCalledWith(
      '/user-data',
      {
        selector: environment.id
      },
      { isActiveEnvironment: expect.any(Function) }
    )
    expect(invalidateTransport).toHaveBeenCalledWith(environment.id)
  })
})
