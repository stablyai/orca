import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'

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
    retryRemoteRuntimeSharedControlConnectionsNowMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('dedupes concurrent shared-control capability probes per environment', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    let resolveStatus: (value: unknown) => void = () => {}
    sendRemoteRuntimeRequestMock.mockImplementation((_pairing, method) => {
      if (method === 'status.get') {
        return new Promise((resolve) => {
          resolveStatus = resolve
        })
      }
      throw new Error(`unexpected legacy call: ${method}`)
    })
    sendRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      id: 'shared',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    const first = call(null, { selector: 'desk', method: 'repo.list' })
    const second = call(null, { selector: 'desk', method: 'worktree.ps' })
    await vi.waitFor(() => expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(1))

    resolveStatus({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })

    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual(['status.get'])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledTimes(2)
  })

  it('clears rejected shared-control capability probes so a later call can retry', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValueOnce({
        id: 'status',
        ok: true,
        result: { runtimeId: 'runtime-remote', capabilities: [] },
        _meta: { runtimeId: 'runtime-remote' }
      })
      .mockResolvedValueOnce({
        id: 'repo-list',
        ok: true,
        result: { repos: [] },
        _meta: { runtimeId: 'runtime-remote' }
      })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    await expect(call(null, { selector: 'desk', method: 'repo.list' })).rejects.toThrow(
      'probe failed'
    )
    await expect(call(null, { selector: 'desk', method: 'repo.list' })).resolves.toMatchObject({
      ok: true,
      result: { repos: [] }
    })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'status.get',
      'repo.list'
    ])
  })

  it('clears shared-control capability cache when a runtime is disconnected', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    sendRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      id: 'shared',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    await call(null, { selector: 'desk', method: 'repo.list' })

    const disconnect = handler<
      { selector: string },
      { disconnected: { id: string; name: string } }
    >('runtimeEnvironments:disconnect')
    await disconnect(null, { selector: 'desk' })
    const connect = handler<{ selector: string }, { ok: boolean }>('runtimeEnvironments:connect')
    await connect(null, { selector: 'desk' })
    await call(null, { selector: 'desk', method: 'repo.list' })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'status.get',
      'status.get'
    ])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledTimes(2)
  })

  it('clears shared-control capability cache when a runtime is removed and re-added', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    sendRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      id: 'shared',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-remote' }
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const first = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    await call(null, { selector: first.environment.id, method: 'repo.list' })

    const remove = handler<{ selector: string }, { removed: { id: string; name: string } }>(
      'runtimeEnvironments:remove'
    )
    remove(null, { selector: first.environment.id })
    await add(null, { name: 'desk', pairingCode: pairingCode() })
    await call(null, { selector: 'desk', method: 'repo.list' })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'status.get'
    ])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledTimes(2)
  })
})
