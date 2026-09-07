import { beforeEach, describe, expect, it, vi } from 'vitest'

const handlers = new Map<string, (...args: unknown[]) => unknown>()
const { getPathMock, rehydrateRuntimeOwnedSshForRestoredWorkspacesMock } = vi.hoisted(() => ({
  getPathMock: vi.fn(() => '/user-data'),
  rehydrateRuntimeOwnedSshForRestoredWorkspacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  }
}))

vi.mock('./runtime-owned-ssh-startup-rehydration', () => ({
  rehydrateRuntimeOwnedSshForRestoredWorkspaces: rehydrateRuntimeOwnedSshForRestoredWorkspacesMock
}))

vi.mock('./legacy-worker-renderer-recovery', () => ({
  recoverLegacyWorkerTerminalsForRendererStartup: vi.fn()
}))

vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))

import { mainProcessState } from './main-process-state'
import { registerMainProcessIpcHandlers } from './main-process-ipc-bootstrap'

describe('app:prepareTerminalStartupRestoration', () => {
  beforeEach(() => {
    handlers.clear()
    rehydrateRuntimeOwnedSshForRestoredWorkspacesMock.mockReset()
    rehydrateRuntimeOwnedSshForRestoredWorkspacesMock.mockResolvedValue(undefined)
    mainProcessState.store = { getWorkspaceSessionHostIds: () => [] } as never
    mainProcessState.runtime = null
  })

  it('rehydrates runtime-owned SSH connections before terminals are restored', async () => {
    // Why here: the renderer awaits this barrier before any pty spawn/attach, and it must
    // never dial a runtime-owned target itself.
    registerMainProcessIpcHandlers()

    await handlers.get('app:prepareTerminalStartupRestoration')?.()

    expect(rehydrateRuntimeOwnedSshForRestoredWorkspacesMock).toHaveBeenCalledWith({
      store: mainProcessState.store,
      userDataPath: '/user-data'
    })
  })

  it('still prepares terminal restoration when the rehydration fails', async () => {
    // A failed reconnect is `unverifiable`; it must not block startup.
    rehydrateRuntimeOwnedSshForRestoredWorkspacesMock.mockRejectedValue(new Error('unreachable'))
    registerMainProcessIpcHandlers()

    await expect(handlers.get('app:prepareTerminalStartupRestoration')?.()).resolves.toBeUndefined()
  })
})
