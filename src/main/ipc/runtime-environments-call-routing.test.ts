import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import * as environmentStore from '../../shared/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import { RuntimeRpcCallQueueOverloadError } from '../../shared/runtime-rpc-call-queue'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'

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

  it('proxies generic one-shot RPC calls to the saved remote runtime', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-2',
      ok: true,
      result: { repos: [{ id: 'repo-1' }] },
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
    expect(
      await call(null, { selector: 'desk', method: 'repo.list', timeoutMs: 75 })
    ).toMatchObject({
      ok: true,
      result: { repos: [{ id: 'repo-1' }] }
    })
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'repo.list',
      undefined,
      75
    )
    expect(sendRemoteRuntimeConnectionRequestMock).not.toHaveBeenCalled()
  })

  it('falls back to one-shot RPC when the saved runtime lacks shared-control support', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockImplementation(async (_pairing, method) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: { runtimeId: 'runtime-remote', capabilities: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'repo-list',
        ok: true,
        result: { repos: [{ id: 'repo-1' }] },
        _meta: { runtimeId: 'runtime-remote' }
      }
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
    await expect(call(null, { selector: 'desk', method: 'repo.list' })).resolves.toMatchObject({
      ok: true,
      result: { repos: [{ id: 'repo-1' }] }
    })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'repo.list'
    ])
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('uses the cached request connection for terminal hot path RPCs', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeConnectionRequestMock.mockResolvedValue({
      id: 'rpc-terminal',
      ok: true,
      result: { send: { accepted: true } },
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
    expect(
      await call(null, {
        selector: 'desk',
        method: 'terminal.send',
        params: { terminal: 't1', text: 'a' },
        timeoutMs: 75
      })
    ).toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(sendRemoteRuntimeConnectionRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.send',
      { terminal: 't1', text: 'a' },
      75
    )
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('keeps terminal hot path RPCs on the cached request connection when shared control is supported', async () => {
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
    sendRemoteRuntimeConnectionRequestMock.mockResolvedValue({
      id: 'rpc-terminal',
      ok: true,
      result: { accepted: true },
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
    await expect(
      call(null, {
        selector: 'desk',
        method: 'terminal.send',
        params: { terminal: 't1', text: 'a' },
        timeoutMs: 75
      })
    ).resolves.toMatchObject({ ok: true, result: { accepted: true } })
    await expect(
      call(null, {
        selector: 'desk',
        method: 'terminal.updateViewport',
        params: { terminal: 't1', cols: 120, rows: 40 },
        timeoutMs: 75
      })
    ).resolves.toMatchObject({ ok: true, result: { accepted: true } })

    expect(sendRemoteRuntimeConnectionRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.send',
      { terminal: 't1', text: 'a' },
      75
    )
    expect(sendRemoteRuntimeConnectionRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.updateViewport',
      { terminal: 't1', cols: 120, rows: 40 },
      75
    )
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('routes one-shot RPC calls through shared control when the runtime advertises support', async () => {
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
      id: 'repo-list',
      ok: true,
      result: { repos: [{ id: 'repo-1' }] },
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
    await expect(call(null, { selector: 'desk', method: 'repo.list' })).resolves.toMatchObject({
      ok: true,
      result: { repos: [{ id: 'repo-1' }] }
    })
    await expect(call(null, { selector: 'desk', method: 'worktree.ps' })).resolves.toMatchObject({
      ok: true
    })

    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(1)
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'status.get',
      undefined,
      15_000
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'worktree.ps',
      undefined,
      15_000
    )
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledTimes(2)
    expect(sendRemoteRuntimeConnectionRequestMock).not.toHaveBeenCalled()
  })

  it('rechecks shared-control support when the saved runtime identity changes', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    let statusCalls = 0
    sendRemoteRuntimeRequestMock.mockImplementation(async (_pairing, method) => {
      if (method === 'status.get') {
        statusCalls += 1
        const supportsShared = statusCalls === 1
        return {
          id: 'status',
          ok: true,
          result: {
            runtimeId: supportsShared ? 'runtime-remote' : 'runtime-downgraded',
            capabilities: supportsShared ? [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY] : []
          },
          _meta: { runtimeId: supportsShared ? 'runtime-remote' : 'runtime-downgraded' }
        }
      }
      return {
        id: 'repo-list',
        ok: true,
        result: { repos: [] },
        _meta: { runtimeId: 'runtime-downgraded' }
      }
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
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const call = handler<
      { selector: string; method: string; params?: unknown; timeoutMs?: number },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')
    await call(null, { selector: 'desk', method: 'repo.list' })
    environmentStore.markEnvironmentUsed(userDataPath, added.environment.id, {
      runtimeId: 'runtime-downgraded'
    })
    await call(null, { selector: 'desk', method: 'repo.list' })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'status.get',
      'repo.list'
    ])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    [
      new RemoteRuntimeClientError(
        'remote_runtime_unavailable',
        'Transport vanished without legacy classifier wording.'
      ),
      'remote_runtime_unavailable',
      'Transport vanished without legacy classifier wording.'
    ],
    [
      Object.assign(new RuntimeRpcCallQueueOverloadError('selector'), {
        message: 'Capacity rejected without legacy classifier wording.'
      }),
      'runtime_rpc_queue_overloaded',
      'Capacity rejected without legacy classifier wording.'
    ]
  ])(
    'returns coded transport failure %s so the renderer restores its identity',
    async (transportError, expectedCode, expectedMessage) => {
      registerRuntimeEnvironmentHandlers(store as never)
      sendRemoteRuntimeRequestMock.mockRejectedValue(transportError)

      const add = handler<
        { name: string; pairingCode: string },
        { environment: { id: string; name: string } }
      >('runtimeEnvironments:addFromPairingCode')
      await add(null, { name: 'desk', pairingCode: pairingCode() })
      const call = handler<{ selector: string; method: string }, RuntimeRpcResponse<unknown>>(
        'runtimeEnvironments:call'
      )

      const response = structuredClone(await call(null, { selector: 'desk', method: 'status.get' }))
      expect(response).toMatchObject({
        ok: false,
        error: { code: expectedCode, message: expectedMessage }
      })
      expect(response.ok).toBe(false)
      if (response.ok === false) {
        expect(response.error).toEqual({ code: expectedCode, message: expectedMessage })
      }
    }
  )

  it('keeps uncoded call failures on the rejected IPC fallback path', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockRejectedValue(new Error('shared down'))

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })
    const call = handler<{ selector: string; method: string }, RuntimeRpcResponse<unknown>>(
      'runtimeEnvironments:call'
    )

    await expect(call(null, { selector: 'desk', method: 'status.get' })).rejects.toThrow(
      'shared down'
    )
  })

  it('does not fall back after a shared-control request fails on a supported runtime', async () => {
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
    sendRemoteRuntimeSharedControlRequestMock.mockRejectedValue(new Error('shared down'))

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
      'shared down'
    )

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual(['status.get'])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'repo.list',
      undefined,
      15_000
    )
  })

  it('keeps session snapshot recovery on one-shot transport while shared control reconnects', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockImplementation(async (_pairing, method) => ({
      id: method,
      ok: true,
      result:
        method === 'status.get'
          ? {
              runtimeId: 'runtime-remote',
              capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
            }
          : { snapshots: [] },
      _meta: { runtimeId: 'runtime-remote' }
    }))

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })
    const call = handler<
      { selector: string; method: string; params?: unknown },
      { ok: true; result: unknown }
    >('runtimeEnvironments:call')

    await expect(
      call(null, { selector: 'desk', method: 'session.tabs.listAll' })
    ).resolves.toMatchObject({ ok: true, result: { snapshots: [] } })
    expect(sendRemoteRuntimeRequestMock.mock.calls.map((entry) => entry[1])).toEqual([
      'session.tabs.listAll'
    ])
    expect(sendRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('limits background one-shot RPCs without blocking foreground runtime calls', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const pendingBackground: ((value: unknown) => void)[] = []
    sendRemoteRuntimeRequestMock.mockImplementation(async (_pairing, method) => {
      if (method === 'status.get') {
        return {
          id: 'status',
          ok: true,
          result: { runtimeId: 'runtime-remote', capabilities: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return await new Promise((resolve) => pendingBackground.push(resolve))
    })
    sendRemoteRuntimeConnectionRequestMock.mockResolvedValue({
      id: 'terminal-send',
      ok: true,
      result: { send: { accepted: true } },
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
    const bg1 = call(null, { selector: 'desk', method: 'hostedReview.forBranch' })
    const bg2 = call(null, { selector: 'desk', method: 'github.listWorkItems' })
    await vi.waitFor(() => expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(3))

    const bg3 = call(null, { selector: 'desk', method: 'git.status' })
    const foreground = call(null, {
      selector: 'desk',
      method: 'terminal.send',
      params: { terminal: 'term-1', text: 'a' }
    })
    await vi.waitFor(() =>
      expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
        'status.get',
        'hostedReview.forBranch',
        'github.listWorkItems'
      ])
    )
    await vi.waitFor(() =>
      expect(sendRemoteRuntimeConnectionRequestMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Object),
        'terminal.send',
        { terminal: 'term-1', text: 'a' },
        15_000
      )
    )

    await expect(foreground).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(pendingBackground).toHaveLength(2)

    pendingBackground.shift()?.({
      id: 'background-1',
      ok: true,
      result: null,
      _meta: { runtimeId: 'runtime-remote' }
    })
    await vi.waitFor(() => expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledTimes(4))
    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'hostedReview.forBranch',
      'github.listWorkItems',
      'git.status'
    ])

    pendingBackground.splice(0).forEach((resolve) =>
      resolve({
        id: 'background',
        ok: true,
        result: null,
        _meta: { runtimeId: 'runtime-remote' }
      })
    )
    await expect(bg1).resolves.toMatchObject({ ok: true })
    await expect(bg2).resolves.toMatchObject({ ok: true })
    await expect(bg3).resolves.toMatchObject({ ok: true })
  })
})
