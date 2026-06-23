/* eslint-disable max-lines -- Why: this suite covers runtime environment
   management, secret redaction, one-shot RPC, and streaming cleanup contracts. */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import { REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY } from '../../shared/protocol-version'
import * as environmentStore from '../../shared/runtime-environment-store'

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
  closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
}))

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'

function pairingCode(endpoint = 'ws://127.0.0.1:6768'): string {
  return encodePairingOffer({
    v: 2,
    endpoint,
    deviceToken: 'device-token',
    publicKeyB64: Buffer.from(new Uint8Array(32).fill(1)).toString('base64')
  })
}

function handler<TArgs, TResult>(
  channel: string
): (_event: unknown, args: TArgs) => TResult | Promise<TResult> {
  const match = handleMock.mock.calls.find((call) => call[0] === channel)
  expect(match).toBeTruthy()
  return match![1] as (_event: unknown, args: TArgs) => TResult | Promise<TResult>
}

describe('registerRuntimeEnvironmentHandlers', () => {
  let userDataPath: string

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
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
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers desktop runtime environment management handlers', () => {
    registerRuntimeEnvironmentHandlers()

    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:list',
      'runtimeEnvironments:addFromPairingCode',
      'runtimeEnvironments:resolve',
      'runtimeEnvironments:remove',
      'runtimeEnvironments:disconnect',
      'runtimeEnvironments:getStatus',
      'runtimeEnvironments:call',
      'runtimeEnvironments:subscribe',
      'runtimeEnvironments:unsubscribe'
    ])
    expect(onMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:subscriptionBinary'
    ])
  })

  it('clears stale IPC registrations before registering runtime environment handlers', () => {
    registerRuntimeEnvironmentHandlers()

    expect(removeHandlerMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:list',
      'runtimeEnvironments:addFromPairingCode',
      'runtimeEnvironments:resolve',
      'runtimeEnvironments:remove',
      'runtimeEnvironments:disconnect',
      'runtimeEnvironments:getStatus',
      'runtimeEnvironments:call',
      'runtimeEnvironments:subscribe',
      'runtimeEnvironments:unsubscribe'
    ])
    expect(removeAllListenersMock).toHaveBeenCalledWith('runtimeEnvironments:subscriptionBinary')
  })

  it('stores, resolves, lists, and removes environments under Electron userData', async () => {
    registerRuntimeEnvironmentHandlers()

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
    expect(JSON.stringify(added)).not.toContain('device-token')
    expect(JSON.stringify(added)).not.toContain('publicKeyB64')

    const list = handler<undefined, { id: string; name: string }[]>('runtimeEnvironments:list')
    expect(await list(null, undefined)).toMatchObject([{ id: added.environment.id, name: 'desk' }])
    expect(JSON.stringify(await list(null, undefined))).not.toContain('device-token')

    const resolve = handler<{ selector: string }, { id: string; name: string }>(
      'runtimeEnvironments:resolve'
    )
    expect(await resolve(null, { selector: 'desk' })).toMatchObject({
      id: added.environment.id,
      name: 'desk'
    })
    expect(JSON.stringify(await resolve(null, { selector: 'desk' }))).not.toContain('device-token')

    const remove = handler<{ selector: string }, { removed: { id: string; name: string } }>(
      'runtimeEnvironments:remove'
    )
    const removed = await remove(null, { selector: added.environment.id })
    expect(removed).toMatchObject({
      removed: { id: added.environment.id, name: 'desk' }
    })
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(added.environment.id)
    expect(JSON.stringify(removed)).not.toContain('device-token')
    expect(await list(null, undefined)).toEqual([])
  })

  it('disconnects a saved runtime without removing it', async () => {
    registerRuntimeEnvironmentHandlers()

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const disconnect = handler<
      { selector: string },
      { disconnected: { id: string; name: string } }
    >('runtimeEnvironments:disconnect')
    expect(await disconnect(null, { selector: 'desk' })).toMatchObject({
      disconnected: { id: added.environment.id, name: 'desk' }
    })

    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(added.environment.id)
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith('desk')

    const list = handler<undefined, { id: string; name: string }[]>('runtimeEnvironments:list')
    expect(await list(null, undefined)).toMatchObject([{ id: added.environment.id, name: 'desk' }])
  })

  it('checks a saved remote runtime and records the runtime id on success', async () => {
    registerRuntimeEnvironmentHandlers()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { runtimeId: 'runtime-remote', graphStatus: 'ready' },
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
      50
    )

    const resolve = handler<{ selector: string }, { id: string; runtimeId: string | null }>(
      'runtimeEnvironments:resolve'
    )
    expect(await resolve(null, { selector: added.environment.id })).toMatchObject({
      id: added.environment.id,
      runtimeId: 'runtime-remote'
    })
  })

  it('attaches shared-control diagnostics to saved remote runtime status', async () => {
    registerRuntimeEnvironmentHandlers()
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
      result: { runtimeId: 'runtime-remote', graphStatus: 'ready' },
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
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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

  it('proxies generic one-shot RPC calls to the saved remote runtime', async () => {
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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

  it('does not fall back after a shared-control request fails on a supported runtime', async () => {
    registerRuntimeEnvironmentHandlers()
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

  it('keeps browser and terminal heavy streams on dedicated subscription sockets', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'browser-stream',
      close,
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      { selector: 'desk', method: 'browser.screencast', params: { pageId: 'page-1' } }
    )
    await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      { selector: 'desk', method: 'terminal.multiplex', params: { client: { id: 'client-1' } } }
    )

    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'browser.screencast',
      { pageId: 'page-1' },
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'terminal.multiplex',
      { client: { id: 'client-1' } },
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('routes passive subscriptions through shared control when supported', async () => {
    registerRuntimeEnvironmentHandlers()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      requestId: 'tabs-shared',
      close: vi.fn(),
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    await expect(
      subscribe(
        {
          sender: {
            id: 1,
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
            removeListener: vi.fn()
          }
        },
        { selector: 'desk', method: 'session.tabs.subscribeAll' }
      )
    ).resolves.toMatchObject({ requestId: 'tabs-shared' })

    expect(subscribeRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      'session.tabs.subscribeAll',
      undefined,
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('keeps shared-control subscriptions retained across transient errors until final close', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    const senderSend = vi.fn()
    const destroyedListenerRemoved = vi.fn()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        capabilities: [REMOTE_RUNTIME_SHARED_CONTROL_CAPABILITY]
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeSharedControlRequestMock.mockResolvedValue({
      requestId: 'tabs-shared',
      close,
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: senderSend,
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'session.tabs.subscribeAll',
        subscriptionId: 'shared-sub'
      }
    )

    const callbacks = subscribeRemoteRuntimeSharedControlRequestMock.mock.calls[0]![5] as {
      onError: (error: { code: string; message: string }) => void
      onClose: () => void
    }
    callbacks.onError({ code: 'reconnecting', message: 'temporary drop' })

    expect(senderSend).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId: 'shared-sub',
      type: 'error',
      code: 'reconnecting',
      message: 'temporary drop'
    })
    expect(destroyedListenerRemoved).not.toHaveBeenCalled()

    callbacks.onClose()
    expect(senderSend).toHaveBeenCalledWith('runtimeEnvironments:subscriptionEvent', {
      subscriptionId: 'shared-sub',
      type: 'close'
    })
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
    expect(close).not.toHaveBeenCalled()
  })

  it('falls back to legacy passive subscriptions when shared control is unsupported', async () => {
    registerRuntimeEnvironmentHandlers()
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: { runtimeId: 'runtime-remote', capabilities: [] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'tabs-legacy',
      close: vi.fn(),
      sendBinary: vi.fn()
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      { selector: string; method: string; params?: unknown; subscriptionId?: string },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    await expect(
      subscribe(
        {
          sender: {
            id: 1,
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
            removeListener: vi.fn()
          }
        },
        { selector: 'desk', method: 'session.tabs.subscribeAll' }
      )
    ).resolves.toMatchObject({ requestId: 'tabs-legacy' })

    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.any(Object),
      'session.tabs.subscribeAll',
      undefined,
      15_000,
      expect.any(Object)
    )
    expect(subscribeRemoteRuntimeSharedControlRequestMock).not.toHaveBeenCalled()
  })

  it('dedupes concurrent shared-control capability probes per environment', async () => {
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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
    registerRuntimeEnvironmentHandlers()
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
    await call(null, { selector: 'desk', method: 'repo.list' })

    expect(sendRemoteRuntimeRequestMock.mock.calls.map((call) => call[1])).toEqual([
      'status.get',
      'status.get'
    ])
    expect(sendRemoteRuntimeSharedControlRequestMock).toHaveBeenCalledTimes(2)
  })

  it('clears shared-control capability cache when a runtime is removed and re-added', async () => {
    registerRuntimeEnvironmentHandlers()
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

  it('limits background one-shot RPCs without blocking foreground runtime calls', async () => {
    registerRuntimeEnvironmentHandlers()
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

  it('starts and stops streaming subscriptions for a saved remote runtime', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    const sendBinary = vi.fn()
    const markUsedSpy = vi.spyOn(environmentStore, 'markEnvironmentUsed')
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      async (_pairing, _method, _params, _timeoutMs, callbacks) => {
        callbacks.onResponse({
          id: 'stream-1',
          ok: true,
          result: { type: 'subscribed' },
          _meta: { runtimeId: 'runtime-remote' }
        })
        callbacks.onResponse({
          id: 'stream-1',
          ok: true,
          result: { type: 'data', chunk: 'hello' },
          _meta: { runtimeId: 'runtime-remote' }
        })
        callbacks.onBinary(new Uint8Array([1, 2, 3]))
        return { requestId: 'stream-1', close, sendBinary }
      }
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const sent: unknown[] = []
    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        timeoutMs?: number
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: (_channel: string, payload: unknown) => sent.push(payload),
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        timeoutMs: 25,
        subscriptionId: 'preload-sub-1'
      }
    )

    expect(result.requestId).toBe('stream-1')
    expect(result.subscriptionId).toBe('preload-sub-1')
    expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'terminal.subscribe',
      { terminal: 't1' },
      25,
      expect.any(Object)
    )
    expect(sent).toEqual([
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'response' }),
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'response' }),
      expect.objectContaining({ subscriptionId: result.subscriptionId, type: 'binary' })
    ])
    expect(markUsedSpy).toHaveBeenCalledTimes(1)

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    const bytes = new Uint8Array([9, 8, 7])
    binaryListener({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId, bytes })
    expect(sendBinary).toHaveBeenCalledWith(bytes)

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))
    markUsedSpy.mockRestore()
  })

  it('closes streaming subscriptions when their saved runtime is removed', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    const sendBinary = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-remove',
      close,
      sendBinary
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })

    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'removed-env-sub'
      }
    )

    const remove = handler<{ selector: string }, { removed: { id: string; name: string } }>(
      'runtimeEnvironments:remove'
    )
    expect(remove(null, { selector: added.environment.id })).toMatchObject({
      removed: { id: added.environment.id, name: 'desk' }
    })

    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
  })

  it('rejects cross-window streaming subscription control', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    const sendBinary = vi.fn()
    subscribeRemoteRuntimeRequestMock.mockResolvedValue({
      requestId: 'stream-1',
      close,
      sendBinary
    })

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const result = await subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => false,
          send: vi.fn(),
          once: vi.fn(),
          removeListener: vi.fn()
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'owned-sub'
      }
    )

    const binaryListener = onMock.mock.calls.find(
      (call) => call[0] === 'runtimeEnvironments:subscriptionBinary'
    )?.[1] as (_event: unknown, args: unknown) => void
    binaryListener(
      { sender: { id: 2 } },
      { subscriptionId: result.subscriptionId, bytes: new Uint8Array([1]) }
    )
    expect(sendBinary).not.toHaveBeenCalled()

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(
      await unsubscribe({ sender: { id: 2 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: false
    })
    expect(close).not.toHaveBeenCalled()

    expect(
      await unsubscribe({ sender: { id: 1 } }, { subscriptionId: result.subscriptionId })
    ).toEqual({
      unsubscribed: true
    })
    expect(close).toHaveBeenCalled()
  })

  it('closes a streaming subscription that resolves after the sender is destroyed', async () => {
    registerRuntimeEnvironmentHandlers()
    const close = vi.fn()
    let resolveSubscribe: (value: {
      requestId: string
      close: () => void
      sendBinary: (bytes: Uint8Array<ArrayBufferLike>) => boolean
    }) => void = () => {}
    subscribeRemoteRuntimeRequestMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSubscribe = resolve
        })
    )

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    let destroyed = false
    let destroyedHandler: unknown = null
    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')
    const resultPromise = subscribe(
      {
        sender: {
          id: 1,
          isDestroyed: () => destroyed,
          send: vi.fn(),
          once: vi.fn((_event: string, handler: () => void) => {
            destroyedHandler = () => {
              destroyed = true
              handler()
            }
          }),
          removeListener: destroyedListenerRemoved
        }
      },
      {
        selector: 'desk',
        method: 'terminal.subscribe',
        params: { terminal: 't1' },
        subscriptionId: 'late-sub'
      }
    )

    await vi.waitFor(() => {
      expect(subscribeRemoteRuntimeRequestMock).toHaveBeenCalled()
    })
    expect(destroyedHandler).toBeTypeOf('function')
    ;(destroyedHandler as () => void)()
    resolveSubscribe({ requestId: 'stream-late', close, sendBinary: vi.fn() })

    await expect(resultPromise).resolves.toEqual({
      subscriptionId: 'late-sub',
      requestId: 'stream-late'
    })
    expect(close).toHaveBeenCalledTimes(1)
    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))

    const unsubscribe = handler<{ subscriptionId: string }, { unsubscribed: boolean }>(
      'runtimeEnvironments:unsubscribe'
    )
    expect(await unsubscribe({ sender: { id: 1 } }, { subscriptionId: 'late-sub' })).toEqual({
      unsubscribed: false
    })
  })

  it('removes the destroyed listener when streaming subscription setup rejects', async () => {
    registerRuntimeEnvironmentHandlers()
    subscribeRemoteRuntimeRequestMock.mockRejectedValue(new Error('connect failed'))

    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    await add(null, { name: 'desk', pairingCode: pairingCode() })

    const destroyedListenerRemoved = vi.fn()
    const subscribe = handler<
      {
        selector: string
        method: string
        params?: unknown
        subscriptionId?: string
      },
      { subscriptionId: string; requestId: string }
    >('runtimeEnvironments:subscribe')

    await expect(
      subscribe(
        {
          sender: {
            id: 1,
            isDestroyed: () => false,
            send: vi.fn(),
            once: vi.fn(),
            removeListener: destroyedListenerRemoved
          }
        },
        {
          selector: 'desk',
          method: 'terminal.subscribe',
          params: { terminal: 't1' },
          subscriptionId: 'failed-sub'
        }
      )
    ).rejects.toThrow('connect failed')

    expect(destroyedListenerRemoved).toHaveBeenCalledWith('destroyed', expect.any(Function))
  })
})
