import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY
} from '../../shared/protocol-version'

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
  ensureRemoteRuntimeSharedControlConnectionMock,
  pauseRemoteRuntimeSharedControlRetryMock,
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
  ensureRemoteRuntimeSharedControlConnectionMock: vi.fn(),
  pauseRemoteRuntimeSharedControlRetryMock: vi.fn(),
  retryRemoteRuntimeSharedControlConnectionsNowMock: vi.fn(),
  closeRemoteRuntimeRequestConnectionMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: getPathMock },
  ipcMain: {
    handle: handleMock,
    on: onMock,
    removeHandler: removeHandlerMock,
    removeAllListeners: removeAllListenersMock
  }
}))

vi.mock('../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', () => ({
  sendRemoteRuntimeConnectionRequest: sendRemoteRuntimeConnectionRequestMock,
  sendRemoteRuntimeSharedControlRequest: sendRemoteRuntimeSharedControlRequestMock,
  subscribeRemoteRuntimeSharedControlRequest: subscribeRemoteRuntimeSharedControlRequestMock,
  getRemoteRuntimeSharedControlDiagnostics: getRemoteRuntimeSharedControlDiagnosticsMock,
  reconnectRemoteRuntimeSharedControlConnection: reconnectRemoteRuntimeSharedControlConnectionMock,
  retryRemoteRuntimeSharedControlConnectionsNow: retryRemoteRuntimeSharedControlConnectionsNowMock,
  retryRemoteRuntimeSharedControlConnectionNow: vi.fn(),
  ensureRemoteRuntimeSharedControlConnection: ensureRemoteRuntimeSharedControlConnectionMock,
  pauseRemoteRuntimeSharedControlRetry: pauseRemoteRuntimeSharedControlRetryMock,
  closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
}))

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
import { channelHandlerLookup, pairingCode } from './runtime-environments-ipc-test-harness'

const handler = channelHandlerLookup(handleMock)

describe('registerRuntimeEnvironmentHandlers', () => {
  let userDataPath: string
  let activeRuntimeEnvironmentId: string | null
  let store: {
    getSettings: () => { activeRuntimeEnvironmentId: string | null }
    updateSettings: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    activeRuntimeEnvironmentId = null
    store = {
      getSettings: () => ({ activeRuntimeEnvironmentId }),
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
    ensureRemoteRuntimeSharedControlConnectionMock.mockReset()
    pauseRemoteRuntimeSharedControlRetryMock.mockReset()
    retryRemoteRuntimeSharedControlConnectionsNowMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('checks a saved remote runtime and records the runtime id on success', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        graphStatus: 'ready',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const getStatus = handler<
      { selector: string; timeoutMs?: number },
      { ok: true; result: { runtimeId: string } }
    >('runtimeEnvironments:getStatus')
    expect(await getStatus(null, { selector: 'desk', timeoutMs: 50 })).toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-remote' }
    })
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768', deviceToken: 'device-token' }),
      'status.get',
      undefined,
      50,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(reconnectRemoteRuntimeSharedControlConnectionMock).toHaveBeenCalledWith(
      added.environment.id
    )
    expect(ensureRemoteRuntimeSharedControlConnectionMock).toHaveBeenCalledWith(
      added.environment.id,
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' })
    )

    const resolve = handler<{ selector: string }, { id: string; runtimeId: string | null }>(
      'runtimeEnvironments:resolve'
    )
    expect(await resolve(null, { selector: added.environment.id })).toMatchObject({
      id: added.environment.id,
      runtimeId: 'runtime-remote'
    })
  })

  it('observes diagnostics without ensuring, refreshing, or marking the environment used', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue({
      state: 'reconnecting',
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 2,
      lastConnectedAt: null,
      lastClose: null,
      lastError: 'offline'
    })
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        graphStatus: 'ready',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const add = handler<{ name: string; pairingCode: string }, { environment: { id: string } }>(
      'runtimeEnvironments:addFromPairingCode'
    )
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
    const getStatus = handler<
      { selector: string; observeOnly?: true },
      { ok: true; result: { remoteControl: { state: string } } }
    >('runtimeEnvironments:getStatus')

    await expect(getStatus(null, { selector: 'desk', observeOnly: true })).resolves.toMatchObject({
      result: { remoteControl: { state: 'reconnecting' } }
    })
    expect(ensureRemoteRuntimeSharedControlConnectionMock).not.toHaveBeenCalled()
    expect(reconnectRemoteRuntimeSharedControlConnectionMock).not.toHaveBeenCalled()
    const resolve = handler<{ selector: string }, { runtimeId: string | null }>(
      'runtimeEnvironments:resolve'
    )
    expect((await resolve(null, { selector: added.environment.id })).runtimeId).toBeNull()
  })

  it('strips diagnostics from successful capability-less status results', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue({
      state: 'reconnecting',
      pendingRequestCount: 0,
      subscriptionCount: 0,
      reconnectAttempt: 1,
      lastConnectedAt: null,
      lastClose: null,
      lastError: null
    })
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: { runtimeId: 'runtime-legacy', graphStatus: 'ready', capabilities: [] },
      _meta: { runtimeId: 'runtime-legacy' }
    })
    const add = handler<{ name: string; pairingCode: string }, unknown>(
      'runtimeEnvironments:addFromPairingCode'
    )
    await add(null, { name: 'desk', pairingCode: pairingCode() })
    const getStatus = handler<{ selector: string }, { result: { remoteControl?: unknown } }>(
      'runtimeEnvironments:getStatus'
    )

    const result = await getStatus(null, { selector: 'desk' })
    expect(result.result.remoteControl).toBeUndefined()
    expect(pauseRemoteRuntimeSharedControlRetryMock).toHaveBeenCalledOnce()
  })

  it('attaches shared-control diagnostics to saved remote runtime status', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue({
      state: 'reconnecting',
      pendingRequestCount: 1,
      subscriptionCount: 2,
      reconnectAttempt: 1,
      lastConnectedAt: 123,
      lastClose: { code: 1006, reason: '' },
      lastError: 'closed'
    })
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        graphStatus: 'ready',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const getStatus = handler<
      { selector: string; timeoutMs?: number },
      { ok: true; result: { remoteControl?: { state: string; subscriptionCount: number } } }
    >('runtimeEnvironments:getStatus')

    await expect(getStatus(null, { selector: 'desk' })).resolves.toMatchObject({
      ok: true,
      result: { remoteControl: { state: 'reconnecting', subscriptionCount: 2 } }
    })
    expect(getRemoteRuntimeSharedControlDiagnosticsMock).toHaveBeenCalledWith(added.environment.id)
  })

  it('attaches shared-control diagnostics to failed saved remote runtime status', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue({
      state: 'reconnecting',
      pendingRequestCount: 0,
      subscriptionCount: 1,
      reconnectAttempt: 2,
      lastConnectedAt: 123,
      lastClose: { code: 1006, reason: '' },
      lastError: 'closed'
    })
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-status',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'down' },
      _meta: { runtimeId: null }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const getStatus = handler<
      { selector: string; timeoutMs?: number },
      {
        ok: false
        error: { data?: { remoteControl?: { state: string; subscriptionCount: number } } }
      }
    >('runtimeEnvironments:getStatus')

    await expect(getStatus(null, { selector: 'desk' })).resolves.toMatchObject({
      ok: false,
      error: { data: { remoteControl: { state: 'reconnecting', subscriptionCount: 1 } } }
    })
  })

  it('returns shared-control diagnostics when saved remote runtime status throws', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    getRemoteRuntimeSharedControlDiagnosticsMock.mockReturnValue({
      state: 'reconnecting',
      pendingRequestCount: 0,
      subscriptionCount: 1,
      reconnectAttempt: 2,
      lastConnectedAt: 123,
      lastClose: { code: 1006, reason: '' },
      lastError: 'closed'
    })
    sendRemoteRuntimeRequestMock.mockRejectedValue(new Error('socket closed'))

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const getStatus = handler<
      { selector: string; timeoutMs?: number },
      { ok: false; error: { message: string; data?: { remoteControl?: { state: string } } } }
    >('runtimeEnvironments:getStatus')

    await expect(getStatus(null, { selector: 'desk' })).resolves.toMatchObject({
      ok: false,
      error: {
        message: 'socket closed',
        data: { remoteControl: { state: 'reconnecting' } }
      }
    })
  })
})
