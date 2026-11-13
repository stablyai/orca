import '../../../../shared/remote-runtime/host-store/environment-store-worker.test-support'
import { resetRuntimeEnvironmentStatusOwners } from '../connections/runtime-environment-request-connections'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as environmentStore from '../../../../shared/remote-runtime/host-store/runtime-environment-store'

const {
  handleMock,
  onMock,
  removeHandlerMock,
  removeAllListenersMock,
  getPathMock,
  sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequestMock,
  sendRemoteRuntimeConnectionRequestMock,
  sendRemoteRuntimeSharedControlRequestMock,
  subscribeRemoteRuntimeSharedControlRequestMock,
  getRemoteRuntimeSharedControlDiagnosticsMock,
  reconnectRemoteRuntimeSharedControlConnectionMock,
  retryRemoteRuntimeSharedControlConnectionsNowMock,
  closeRemoteRuntimeRequestConnectionMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  onMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  removeAllListenersMock: vi.fn(),
  getPathMock: vi.fn(),
  sendRemoteRuntimeRequestMock: vi.fn(),
  subscribeRemoteRuntimeRequestMock: vi.fn(),
  sendRemoteRuntimeConnectionRequestMock: vi.fn(),
  sendRemoteRuntimeSharedControlRequestMock: vi.fn(),
  subscribeRemoteRuntimeSharedControlRequestMock: vi.fn(),
  getRemoteRuntimeSharedControlDiagnosticsMock: vi.fn(),
  reconnectRemoteRuntimeSharedControlConnectionMock: vi.fn(),
  retryRemoteRuntimeSharedControlConnectionsNowMock: vi.fn(),
  closeRemoteRuntimeRequestConnectionMock: vi.fn()
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-request-socket', () => ({
  sendRemoteRuntimeRequestOnSocket: sendRemoteRuntimeRequestMock
}))
vi.mock('../../../../shared/remote-runtime/requests/remote-runtime-subscription-transport', () => ({
  subscribeRemoteRuntimeTransport: subscribeRemoteRuntimeRequestMock
}))

vi.mock('../connections/runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('../runtime-environments-ipc-test-harness')
  return withRuntimeStatusOwners({
    sendRemoteRuntimeConnectionRequest: sendRemoteRuntimeConnectionRequestMock,
    sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
    subscribeRemoteRuntimeSharedControlRequest: subscribeRemoteRuntimeSharedControlRequestMock,
    getRemoteRuntimeSharedControlDiagnostics: getRemoteRuntimeSharedControlDiagnosticsMock,
    reconnectRemoteRuntimeSharedControlConnection:
      reconnectRemoteRuntimeSharedControlConnectionMock,
    retryRemoteRuntimeSharedControlConnectionsNow:
      retryRemoteRuntimeSharedControlConnectionsNowMock,
    ensureRemoteRuntimeSharedControlConnection: vi.fn(),
    pauseRemoteRuntimeSharedControlRetry: vi.fn(),
    closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
  })
})

import { registerRuntimeEnvironmentHandlers } from '../runtime-environments'
import { channelHandlerLookup, pairingCode } from '../runtime-environments-ipc-test-harness'

const handler = channelHandlerLookup(handleMock)

function runtimeStatus(): Record<string, unknown> {
  return {
    runtimeId: 'runtime-a',
    rendererGraphEpoch: 1,
    graphStatus: 'ready',
    authoritativeWindowId: 1,
    liveTabCount: 0,
    liveLeafCount: 0,
    protocolVersion: 999_999
  }
}

describe('registerRuntimeEnvironmentHandlers', () => {
  let userDataPath: string
  let activeRuntimeEnvironmentId: string | null
  let store: {
    getSettings: () => { activeRuntimeEnvironmentId: string | null }
    updateSettings: ReturnType<typeof vi.fn>
    removeWorkspaceSessionHost: ReturnType<typeof vi.fn>
    setRemoteLayoutSnapshot: ReturnType<typeof vi.fn>
    setHostRepoCatalogSnapshot: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    activeRuntimeEnvironmentId = null
    store = {
      getSettings: () => ({ activeRuntimeEnvironmentId }),
      removeWorkspaceSessionHost: vi.fn(),
      setRemoteLayoutSnapshot: vi.fn(),
      setHostRepoCatalogSnapshot: vi.fn(),
      updateSettings: vi.fn((updates: { activeRuntimeEnvironmentId: string | null }) => {
        activeRuntimeEnvironmentId = updates.activeRuntimeEnvironmentId
      })
    }
    getPathMock.mockReset()
    getPathMock.mockReturnValue(userDataPath)
    handleMock.mockReset()
    onMock.mockReset()
    removeHandlerMock.mockReset()
    removeAllListenersMock.mockReset()
    sendRemoteRuntimeRequestMock.mockReset()
    subscribeRemoteRuntimeRequestMock.mockReset()
    sendRemoteRuntimeConnectionRequestMock.mockReset()
    sendRemoteRuntimeSharedControlRequestMock.mockReset()
    subscribeRemoteRuntimeSharedControlRequestMock.mockReset()
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReset()
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue(null)
    reconnectRemoteRuntimeSharedControlConnectionMock.mockReset()
    retryRemoteRuntimeSharedControlConnectionsNowMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    resetRuntimeEnvironmentStatusOwners()
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('blocks loopback before verification unless an SSH tunnel is declared', async () => {
    await registerRuntimeEnvironmentHandlers(store as never)
    const verifyAndAdd = handler<
      { name: string; pairingCode: string; allowLoopback?: boolean },
      { ok: boolean; kind?: string }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    await expect(
      verifyAndAdd(null, { name: 'desk', pairingCode: pairingCode() })
    ).resolves.toMatchObject({
      ok: false,
      kind: 'host-unreachable'
    })
    expect(await environmentStore.listEnvironments(userDataPath)).toEqual([])
  })

  it('refreshes the saved server when a verified link is for it, and retires its old connection', async () => {
    await registerRuntimeEnvironmentHandlers(store as never)
    const saved = await environmentStore.addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: pairingCode('ws://100.76.32.125:6768')
    })
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-a' }
    })
    const verifyAndAdd = handler<
      { name: string; pairingCode: string },
      { ok: boolean; updatedExisting?: boolean; environment?: { id: string; name: string } }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    await expect(
      verifyAndAdd(null, {
        name: 'desk over relay',
        pairingCode: pairingCode('ws://192.0.2.10:6768', { deviceToken: 'second-token' })
      })
    ).resolves.toMatchObject({
      ok: true,
      updatedExisting: true,
      environment: { id: saved.id, name: 'desk' }
    })
    expect(
      await environmentStore.resolveEnvironmentPairingOffer(userDataPath, saved.id)
    ).toMatchObject({
      endpoint: 'ws://192.0.2.10:6768',
      deviceToken: 'second-token'
    })
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(saved.id)
  })
})
