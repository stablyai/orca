import { beforeEach, describe, expect, it, vi } from 'vitest'

const getAllWindows = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows } }))

import {
  publishRuntimeEnvironmentDiagnostics,
  RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL
} from './runtime-environment-diagnostics-broadcast'

describe('runtime environment diagnostics broadcast', () => {
  beforeEach(() => getAllWindows.mockReset())

  it('publishes to live renderer windows and skips destroyed windows', () => {
    const live = { isDestroyed: () => false, webContents: { send: vi.fn() } }
    const destroyed = { isDestroyed: () => true, webContents: { send: vi.fn() } }
    getAllWindows.mockReturnValue([live, destroyed])
    const event = {
      environmentId: 'env-a',
      transportGeneration: 2,
      diagnostics: {
        state: 'reconnecting' as const,
        pendingRequestCount: 0,
        subscriptionCount: 1,
        reconnectAttempt: 1,
        lastConnectedAt: 1,
        lastClose: null,
        lastError: 'offline'
      }
    }

    publishRuntimeEnvironmentDiagnostics(event)

    expect(live.webContents.send).toHaveBeenCalledWith(
      RUNTIME_ENVIRONMENT_DIAGNOSTICS_CHANNEL,
      event
    )
    expect(destroyed.webContents.send).not.toHaveBeenCalled()
  })
})
