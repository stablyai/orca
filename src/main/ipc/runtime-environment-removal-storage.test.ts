import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock, clearStorageMock, removeEnvironmentMock, resolveEnvironmentMock } = vi.hoisted(
  () => ({
    handleMock: vi.fn(),
    clearStorageMock: vi.fn(),
    removeEnvironmentMock: vi.fn(),
    resolveEnvironmentMock: vi.fn()
  })
)

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

vi.mock('../../shared/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: vi.fn(() => []),
  removeEnvironment: removeEnvironmentMock,
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('../browser/browser-route-partition-storage-runtime', () => ({
  clearBrowserRoutePartitionStorageForEnvironment: clearStorageMock
}))

import { registerRuntimeEnvironmentConnectivityHandlers } from './runtime-environment-connectivity-handlers'

const environment = { id: 'environment-a', name: 'desk', runtimeId: 'runtime-a', endpoints: [] }

function removeHandler(): (event: unknown, args: { selector: string }) => unknown {
  const call = handleMock.mock.calls.find(([channel]) => channel === 'runtimeEnvironments:remove')
  expect(call).toBeTruthy()
  return call![1]
}

beforeEach(() => {
  handleMock.mockReset()
  clearStorageMock.mockReset()
  removeEnvironmentMock.mockReset().mockReturnValue(environment)
  resolveEnvironmentMock.mockReset().mockReturnValue(environment)
})

describe('runtime environment removal storage clearing', () => {
  it('retires the canonical session partition only after the registry removal succeeds', () => {
    const deleteHostWorkspaceSession = vi.fn()
    const invalidateTransport = vi.fn()
    registerRuntimeEnvironmentConnectivityHandlers({
      store: { getSettings: () => ({}), deleteHostWorkspaceSession } as never,
      getUserDataPath: () => '/tmp/orca-user-data',
      invalidateTransport
    })
    removeEnvironmentMock.mockImplementationOnce(() => {
      throw new Error('write failed')
    })
    expect(() => removeHandler()(null, { selector: 'desk' })).toThrow('write failed')
    expect(deleteHostWorkspaceSession).not.toHaveBeenCalled()
    expect(invalidateTransport).not.toHaveBeenCalled()

    clearStorageMock.mockResolvedValue({ clearedPartitions: [], livePartitions: [] })
    removeHandler()(null, { selector: 'desk' })
    expect(deleteHostWorkspaceSession).toHaveBeenCalledExactlyOnceWith('runtime:environment-a')
    expect(deleteHostWorkspaceSession.mock.invocationCallOrder[0]).toBeGreaterThan(
      removeEnvironmentMock.mock.invocationCallOrder[1]
    )
  })

  it('clears client-hosted browser storage after the client host teardown settles', async () => {
    let finishTeardown = (): void => {}
    const teardown = new Promise<void>((resolve) => {
      finishTeardown = resolve
    })
    clearStorageMock.mockResolvedValue({ clearedPartitions: ['persist:one'], livePartitions: [] })
    registerRuntimeEnvironmentConnectivityHandlers({
      store: { getSettings: () => ({}), deleteHostWorkspaceSession: vi.fn() } as never,
      getUserDataPath: () => '/tmp/orca-user-data',
      invalidateTransport: () => teardown
    })

    expect(removeHandler()(null, { selector: 'environment-a' })).toMatchObject({
      removed: { id: 'environment-a' }
    })
    await Promise.resolve()
    expect(clearStorageMock).not.toHaveBeenCalled()

    finishTeardown()
    await vi.waitFor(() => expect(clearStorageMock).toHaveBeenCalledWith('environment-a'))
  })

  it('retries a partition the first pass refused as live', async () => {
    clearStorageMock
      .mockResolvedValueOnce({ clearedPartitions: [], livePartitions: ['persist:one'] })
      .mockResolvedValueOnce({ clearedPartitions: ['persist:one'], livePartitions: [] })
    registerRuntimeEnvironmentConnectivityHandlers({
      store: { getSettings: () => ({}), deleteHostWorkspaceSession: vi.fn() } as never,
      getUserDataPath: () => '/tmp/orca-user-data',
      invalidateTransport: () => Promise.resolve()
    })

    removeHandler()(null, { selector: 'environment-a' })

    await vi.waitFor(() => expect(clearStorageMock).toHaveBeenCalledTimes(2), { timeout: 2_000 })
  })
})
