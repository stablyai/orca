import { beforeEach, describe, expect, it, vi } from 'vitest'

const { collectMemorySnapshotMock, callRuntimeEnvironmentMock, handleMock, getPathMock } =
  vi.hoisted(() => ({
    collectMemorySnapshotMock: vi.fn(),
    callRuntimeEnvironmentMock: vi.fn(),
    handleMock: vi.fn(),
    getPathMock: vi.fn(() => '/tmp/orca-user-data')
  }))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock
  }
}))

vi.mock('../memory/collector', () => ({
  collectMemorySnapshot: collectMemorySnapshotMock
}))

vi.mock('./runtime-environment-transport-routing', () => ({
  callRuntimeEnvironment: callRuntimeEnvironmentMock
}))

import { registerMemoryHandlers } from './memory'

describe('memory:getSnapshot', () => {
  beforeEach(() => {
    handleMock.mockReset()
    collectMemorySnapshotMock.mockReset()
    callRuntimeEnvironmentMock.mockReset()
    getPathMock.mockReturnValue('/tmp/orca-user-data')
  })

  function getHandler(): () => Promise<unknown> {
    registerMemoryHandlers({
      getSettings: () => ({ activeRuntimeEnvironmentId: null })
    } as never)
    const entry = handleMock.mock.calls.find((call) => call[0] === 'memory:getSnapshot')
    expect(entry).toBeTruthy()
    return entry![1] as () => Promise<unknown>
  }

  it('uses the local collector when no runtime environment is focused', async () => {
    const localSnap = { collectedAt: 1, worktrees: [] }
    collectMemorySnapshotMock.mockResolvedValue(localSnap)
    const handler = getHandler()
    await expect(handler()).resolves.toBe(localSnap)
    expect(callRuntimeEnvironmentMock).not.toHaveBeenCalled()
    expect(collectMemorySnapshotMock).toHaveBeenCalledTimes(1)
  })

  it('proxies diagnostics.memory to the active runtime environment', async () => {
    handleMock.mockReset()
    const remoteSnap = {
      collectedAt: 99,
      worktrees: [
        {
          worktreeId: 'r::/wt',
          worktreeName: 'wt',
          repoId: 'r',
          repoName: 'r',
          cpu: 12,
          memory: 1000,
          history: [],
          sessions: []
        }
      ]
    }
    callRuntimeEnvironmentMock.mockResolvedValue({ ok: true, result: remoteSnap })
    registerMemoryHandlers({
      getSettings: () => ({ activeRuntimeEnvironmentId: 'env-lxc1' })
    } as never)
    const entry = handleMock.mock.calls.find((call) => call[0] === 'memory:getSnapshot')
    const handler = entry![1] as () => Promise<unknown>
    await expect(handler()).resolves.toEqual(remoteSnap)
    expect(callRuntimeEnvironmentMock).toHaveBeenCalledWith(
      '/tmp/orca-user-data',
      'env-lxc1',
      'diagnostics.memory',
      null
    )
    expect(collectMemorySnapshotMock).not.toHaveBeenCalled()
  })

  it('falls back to the local collector when the runtime call fails', async () => {
    handleMock.mockReset()
    const localSnap = { collectedAt: 2, worktrees: [] }
    collectMemorySnapshotMock.mockResolvedValue(localSnap)
    callRuntimeEnvironmentMock.mockRejectedValue(new Error('offline'))
    registerMemoryHandlers({
      getSettings: () => ({ activeRuntimeEnvironmentId: 'env-lxc1' })
    } as never)
    const entry = handleMock.mock.calls.find((call) => call[0] === 'memory:getSnapshot')
    const handler = entry![1] as () => Promise<unknown>
    await expect(handler()).resolves.toBe(localSnap)
    expect(collectMemorySnapshotMock).toHaveBeenCalledTimes(1)
  })
})
