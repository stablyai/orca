import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES,
  MIN_COMPATIBLE_RUNTIME_SERVER_VERSION
} from '../../shared/protocol-version'
import * as environmentStore from '../../shared/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'

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
  retryRemoteRuntimeSharedControlConnectionNowMock,
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
  retryRemoteRuntimeSharedControlConnectionNowMock: vi.fn(),
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
  retryRemoteRuntimeSharedControlConnectionNow: retryRemoteRuntimeSharedControlConnectionNowMock,
  ensureRemoteRuntimeSharedControlConnection: vi.fn(),
  pauseRemoteRuntimeSharedControlRetry: vi.fn(),
  closeRemoteRuntimeRequestConnection: closeRemoteRuntimeRequestConnectionMock
}))

import { registerRuntimeEnvironmentHandlers } from './runtime-environments'
import { channelHandlerLookup, pairingCode } from './runtime-environments-ipc-test-harness'

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
    retryRemoteRuntimeSharedControlConnectionNowMock.mockReset()
    closeRemoteRuntimeRequestConnectionMock.mockReset()
  })

  afterEach(() => {
    rmSync(userDataPath, { recursive: true, force: true })
  })

  it('registers desktop runtime environment management handlers', () => {
    registerRuntimeEnvironmentHandlers(store as never)

    expect(handleMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:list',
      'runtimeEnvironments:addFromPairingCode',
      'runtimeEnvironments:verifyAndAddFromPairingCode',
      'runtimeEnvironments:resolve',
      'runtimeEnvironments:remove',
      'runtimeEnvironments:disconnect',
      'runtimeEnvironments:connect',
      'runtimeEnvironments:retryControlConnection',
      'runtimeEnvironments:prepareBrowserClientHostPlacement',
      'runtimeEnvironments:retryConnectionsNow',
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
    registerRuntimeEnvironmentHandlers(store as never)

    expect(removeHandlerMock.mock.calls.map((call) => call[0])).toEqual([
      'runtimeEnvironments:list',
      'runtimeEnvironments:addFromPairingCode',
      'runtimeEnvironments:verifyAndAddFromPairingCode',
      'runtimeEnvironments:resolve',
      'runtimeEnvironments:remove',
      'runtimeEnvironments:disconnect',
      'runtimeEnvironments:connect',
      'runtimeEnvironments:retryControlConnection',
      'runtimeEnvironments:prepareBrowserClientHostPlacement',
      'runtimeEnvironments:getStatus',
      'runtimeEnvironments:call',
      'runtimeEnvironments:subscribe',
      'runtimeEnvironments:unsubscribe',
      'runtimeEnvironments:retryConnectionsNow'
    ])
    expect(removeAllListenersMock).toHaveBeenCalledWith('runtimeEnvironments:subscriptionBinary')
  })

  it('advances pending shared-control reconnects through IPC', async () => {
    registerRuntimeEnvironmentHandlers(store as never)

    const retryConnectionsNow = handler<undefined, void>('runtimeEnvironments:retryConnectionsNow')
    await retryConnectionsNow(null, undefined)

    expect(retryRemoteRuntimeSharedControlConnectionsNowMock).toHaveBeenCalledTimes(1)
  })

  it('retries one control connection without reversing manual disconnect intent', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const add = handler<{ name: string; pairingCode: string }, { environment: { id: string } }>(
      'runtimeEnvironments:addFromPairingCode'
    )
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
    const retry = handler<{ selector: string }, void>('runtimeEnvironments:retryControlConnection')

    await retry(null, { selector: 'desk' })
    expect(retryRemoteRuntimeSharedControlConnectionNowMock).toHaveBeenCalledWith(
      added.environment.id
    )
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()

    const disconnect = handler<{ selector: string }, unknown>('runtimeEnvironments:disconnect')
    await disconnect(null, { selector: 'desk' })
    retryRemoteRuntimeSharedControlConnectionNowMock.mockClear()
    await retry(null, { selector: 'desk' })

    expect(retryRemoteRuntimeSharedControlConnectionNowMock).not.toHaveBeenCalled()
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
  })

  it('stores, resolves, lists, and removes environments under Electron userData', async () => {
    registerRuntimeEnvironmentHandlers(store as never)

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
    expect(activeRuntimeEnvironmentId).toBeNull()
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(added.environment.id)
    expect(JSON.stringify(removed)).not.toContain('device-token')
    expect(await list(null, undefined)).toEqual([])
  })

  it('blocks loopback before verification unless an SSH tunnel is declared', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
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
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
    expect(environmentStore.listEnvironments(userDataPath)).toEqual([])
  })

  it('verifies identity, access, status, and compatibility before saving', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-a' }
    })
    const verifyAndAdd = handler<
      { name: string; pairingCode: string; allowLoopback?: boolean },
      { ok: boolean; environment?: { name: string; connectionDependency?: string } }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    const result = await verifyAndAdd(null, {
      name: 'desk',
      pairingCode: pairingCode(),
      allowLoopback: true
    })

    expect(result).toMatchObject({
      ok: true,
      environment: { name: 'desk', connectionDependency: 'ssh-tunnel' }
    })
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:6768' }),
      'status.get',
      undefined,
      15_000,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    expect(environmentStore.listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('does not mark non-loopback hosts as SSH-tunnel dependent', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-a' }
    })
    const verifyAndAdd = handler<
      { name: string; pairingCode: string; allowLoopback?: boolean },
      { ok: boolean; environment?: { connectionDependency?: string } }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    const result = await verifyAndAdd(null, {
      name: 'desk',
      pairingCode: pairingCode('ws://100.76.32.125:6768'),
      allowLoopback: true
    })

    expect(result).toMatchObject({ ok: true })
    expect(result.environment).not.toHaveProperty('connectionDependency')
  })

  it.each([
    [{ protocolVersion: MIN_COMPATIBLE_RUNTIME_SERVER_VERSION - 1 }, 'protocol-incompatible'],
    [{ protocolVersion: 999_999, deviceScope: 'mobile' }, 'access-link-invalid'],
    [null, 'connection-interrupted']
  ])('does not save a host with rejected status %o', async (status, expectedKind) => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: status,
      _meta: { runtimeId: 'runtime-a' }
    })
    const verifyAndAdd = handler<
      { name: string; pairingCode: string },
      { ok: boolean; kind?: string }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    await expect(
      verifyAndAdd(null, {
        name: 'desk',
        pairingCode: pairingCode('ws://100.76.32.125:6768')
      })
    ).resolves.toMatchObject({ ok: false, kind: expectedKind })
    expect(environmentStore.listEnvironments(userDataPath)).toEqual([])
  })

  it.each([
    [
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'closed', {
        pairingStage: 'host-identity',
        closeCode: 4001
      }),
      'host-identity-mismatch'
    ],
    [
      new RemoteRuntimeClientError('unauthorized', 'rejected', {
        pairingStage: 'access-grant'
      }),
      'access-link-invalid'
    ],
    [
      new RemoteRuntimeClientError('remote_runtime_unavailable', 'offline', {
        pairingStage: 'connect'
      }),
      'host-unreachable'
    ],
    [new Error('Invalid public key: expected 32 bytes, got 3'), 'access-link-invalid']
  ] as const)('returns a structured pairing failure for %s', async (error, expectedKind) => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockRejectedValue(error)
    const verifyAndAdd = handler<
      { name: string; pairingCode: string },
      { ok: boolean; kind?: string; message?: string }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    const result = await verifyAndAdd(null, {
      name: 'desk',
      pairingCode: pairingCode('ws://100.76.32.125:6768')
    })

    expect(result).toMatchObject({ ok: false, kind: expectedKind })
    expect(result.message).not.toContain('4001')
    expect(environmentStore.listEnvironments(userDataPath)).toEqual([])
  })

  it('returns a structured failure when a verified host cannot be persisted', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    environmentStore.addEnvironmentFromPairingCode(userDataPath, {
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
      { ok: boolean; kind?: string; message?: string }
    >('runtimeEnvironments:verifyAndAddFromPairingCode')

    await expect(
      verifyAndAdd(null, {
        name: 'desk',
        pairingCode: pairingCode('ws://100.76.32.125:6768')
      })
    ).resolves.toMatchObject({
      ok: false,
      kind: 'environment-save-failed',
      message: 'A server named "desk" already exists.'
    })
    expect(environmentStore.listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('requires an explicit Advanced selection before removing the Active Server', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const add = handler<
      { name: string; pairingCode: string },
      { environment: { id: string; name: string } }
    >('runtimeEnvironments:addFromPairingCode')
    const added = await add(null, { name: 'desk', pairingCode: pairingCode() })
    activeRuntimeEnvironmentId = added.environment.id
    const remove = handler<{ selector: string }, { removed: { id: string } }>(
      'runtimeEnvironments:remove'
    )

    expect(() => remove(null, { selector: added.environment.id })).toThrow(
      'Choose another Active Server in Advanced'
    )
    expect(activeRuntimeEnvironmentId).toBe(added.environment.id)
    expect(store.updateSettings).not.toHaveBeenCalled()
  })

  it('disconnects a saved runtime without removing it', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: { runtimeId: 'runtime-remote' },
      _meta: { runtimeId: 'runtime-remote' }
    })

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

    const getStatus = handler<{ selector: string }, { ok: boolean; error?: { code: string } }>(
      'runtimeEnvironments:getStatus'
    )
    await expect(getStatus(null, { selector: 'desk' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
    const call = handler<
      { selector: string; method: string },
      { ok: boolean; error?: { code: string } }
    >('runtimeEnvironments:call')
    await expect(call(null, { selector: 'desk', method: 'repo.list' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'runtime_manually_disconnected' }
    })
    const subscribe = handler<{ selector: string; method: string }, { subscriptionId: string }>(
      'runtimeEnvironments:subscribe'
    )
    await expect(
      subscribe(null, { selector: 'desk', method: 'terminal.multiplex' })
    ).rejects.toThrow('runtime_manually_disconnected')
    expect(sendRemoteRuntimeRequestMock).not.toHaveBeenCalled()
    expect(subscribeRemoteRuntimeRequestMock).not.toHaveBeenCalled()

    const connect = handler<{ selector: string }, { ok: boolean; result?: { runtimeId: string } }>(
      'runtimeEnvironments:connect'
    )
    await expect(connect(null, { selector: 'desk' })).resolves.toMatchObject({
      ok: true,
      result: { runtimeId: 'runtime-remote' }
    })
    expect(sendRemoteRuntimeRequestMock).toHaveBeenCalledOnce()
  })

  it('marks environments owned by ephemeral VM runtimes in the public list', async () => {
    registerRuntimeEnvironmentHandlers(store as never)

    // The ephemeral-VM provision flow persists `source: 'ephemeral-vm'` directly
    // on the environment record (ephemeral-vm.ts), so the public list reads it
    // straight from the record rather than cross-referencing the VM runtime store.
    const added = environmentStore.addEnvironmentFromPairingCode(userDataPath, {
      name: 'orca VM abc12345',
      pairingCode: pairingCode(),
      source: 'ephemeral-vm'
    })

    const list = handler<undefined, { id: string; name: string; source?: string }[]>(
      'runtimeEnvironments:list'
    )

    expect(await list(null, undefined)).toMatchObject([
      { id: added.id, name: 'orca VM abc12345', source: 'ephemeral-vm' }
    ])
  })
})
