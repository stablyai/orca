import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  handleMock,
  clearStorageMock,
  clearCredentialsMock,
  removeEnvironmentMock,
  resolveEnvironmentMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  clearStorageMock: vi.fn(),
  clearCredentialsMock: vi.fn(),
  removeEnvironmentMock: vi.fn(),
  resolveEnvironmentMock: vi.fn()
}))

vi.mock('../../credentials/runtime-edge-auth-store', async (importOriginal) => ({
  ...(await importOriginal()),
  clearRuntimeEdgeAuth: clearCredentialsMock
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))

vi.mock('../../../shared/remote-runtime/host-store/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: vi.fn(),
  listEnvironments: vi.fn(() => []),
  removeEnvironment: removeEnvironmentMock,
  resolveEnvironment: resolveEnvironmentMock
}))

vi.mock('../../browser/routing/partitions/browser-route-partition-storage-runtime', () => ({
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
  clearCredentialsMock.mockReset().mockResolvedValue(undefined)
  removeEnvironmentMock.mockReset().mockReturnValue(environment)
  resolveEnvironmentMock.mockReset().mockReturnValue(environment)
})

afterEach(() => vi.restoreAllMocks())

describe('runtime environment removal storage clearing', () => {
  it.each([false, true])(
    'keeps removal and browser cleanup accurate when credential cleanup fails=%s',
    async (fails) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      if (fails) {
        clearCredentialsMock.mockRejectedValue(new Error('locked synthetic-secret credential file'))
      }
      let finishTeardown = (): void => {}
      const teardown = new Promise<void>((resolve) => {
        finishTeardown = resolve
      })
      clearStorageMock.mockResolvedValue({ clearedPartitions: ['persist:one'], livePartitions: [] })
      registerRuntimeEnvironmentConnectivityHandlers({
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: remove reads only settings and the session-host prune.
        store: {
          getSettings: () => ({}),
          removeWorkspaceSessionHost: vi.fn(),
          setRemoteLayoutSnapshot: vi.fn(),
          setHostRepoCatalogSnapshot: vi.fn()
        } as never,
        getUserDataPath: () => '/tmp/orca-user-data',
        invalidateTransport: () => teardown
      })

      expect(removeHandler()(null, { selector: 'environment-a' })).toMatchObject({
        removed: { id: 'environment-a' }
      })
      expect(clearCredentialsMock).toHaveBeenCalledExactlyOnceWith(
        '/tmp/orca-user-data',
        'environment-a'
      )
      if (fails) {
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith('[runtime-environments] edge credential cleanup failed')
        )
        expect(JSON.stringify(warn.mock.calls)).not.toContain('synthetic-secret')
      }
      await Promise.resolve()
      expect(clearStorageMock).not.toHaveBeenCalled()

      finishTeardown()
      await vi.waitFor(() => expect(clearStorageMock).toHaveBeenCalledWith('environment-a'))
    }
  )
})
