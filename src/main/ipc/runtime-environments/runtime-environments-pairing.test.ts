import type { RuntimeHostStatusSnapshot } from '../../../shared/runtime-host-status'
import {
  getRuntimeEnvironmentStatusSnapshots,
  resetRuntimeEnvironmentStatusOwners
} from './runtime-environment-request-connections'
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MIN_COMPATIBLE_RUNTIME_SERVER_VERSION } from '../../../shared/protocol-version'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import * as environmentStore from '../../../shared/runtime-environment-store'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime-client-error'

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

vi.mock('../../../shared/remote-runtime-client', () => ({
  sendRemoteRuntimeRequest: sendRemoteRuntimeRequestMock,
  subscribeRemoteRuntimeRequest: subscribeRemoteRuntimeRequestMock
}))

vi.mock('./runtime-environment-request-connections', async () => {
  const { withRuntimeStatusOwners } = await import('./runtime-environments-ipc-test-harness')
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
    removeWorkspaceSessionHost: ReturnType<typeof vi.fn>
    setRemoteLayoutSnapshot: ReturnType<typeof vi.fn>
  }

  beforeEach(() => {
    userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-env-ipc-'))
    activeRuntimeEnvironmentId = null
    store = {
      getSettings: () => ({ activeRuntimeEnvironmentId }),
      removeWorkspaceSessionHost: vi.fn(),
      setRemoteLayoutSnapshot: vi.fn(),
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

  it('replaces stale registrations and keeps one binary listener when registered again', async () => {
    const channels = new Set(['runtimeEnvironments:list', 'runtimeEnvironments:restartOrcad'])
    const listeners = new EventEmitter()
    listeners.on('runtimeEnvironments:subscriptionBinary', vi.fn())
    handleMock.mockImplementation((channel: string) => {
      if (channels.has(channel)) {
        throw new Error(`Handler already registered: ${channel}`)
      }
      channels.add(channel)
    })
    removeHandlerMock.mockImplementation((channel: string) => channels.delete(channel))
    onMock.mockImplementation((channel: string, listener: (...args: unknown[]) => void) =>
      listeners.on(channel, listener)
    )
    removeAllListenersMock.mockImplementation((channel: string) =>
      listeners.removeAllListeners(channel)
    )

    try {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This registrar only reads the fixture's settings and workspace-session methods.
      registerRuntimeEnvironmentHandlers(store as never)
      handleMock.mockClear()
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This registrar only reads the fixture's settings and workspace-session methods.
      registerRuntimeEnvironmentHandlers(store as never)

      expect(listeners.listenerCount('runtimeEnvironments:subscriptionBinary')).toBe(1)
      expect(channels.has('runtimeEnvironments:restartOrcad')).toBe(true)
      const list = handler<undefined, unknown[]>('runtimeEnvironments:list')
      expect(await list(null, undefined)).toEqual([])
    } finally {
      handleMock.mockReset()
      removeHandlerMock.mockReset()
      onMock.mockReset()
      removeAllListenersMock.mockReset()
    }
  })

  it('advances pending shared-control reconnects through IPC', async () => {
    registerRuntimeEnvironmentHandlers(store as never)

    const retryConnectionsNow = handler<undefined, void>('runtimeEnvironments:retryConnectionsNow')
    await retryConnectionsNow(null, undefined)

    expect(retryRemoteRuntimeSharedControlConnectionsNowMock).toHaveBeenCalledTimes(1)
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
    expect(store.removeWorkspaceSessionHost).toHaveBeenCalledWith(
      `runtime:${encodeURIComponent(added.environment.id)}`
    )
    expect(store.setRemoteLayoutSnapshot).toHaveBeenCalledWith(added.environment.id, null, 'now')
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
        pairingCode: pairingCode('ws://100.76.32.125:6768', { keyByte: 2 })
      })
    ).resolves.toMatchObject({
      ok: false,
      kind: 'environment-save-failed',
      message: 'A server named "desk" already exists.'
    })
    expect(environmentStore.listEnvironments(userDataPath)).toHaveLength(1)
  })

  it('refreshes the saved server when a verified link is for it, and retires its old connection', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const saved = environmentStore.addEnvironmentFromPairingCode(userDataPath, {
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
    expect(environmentStore.listEnvironments(userDataPath)).toHaveLength(1)
    expect(environmentStore.resolveEnvironmentPairingOffer(userDataPath, saved.id)).toMatchObject({
      endpoint: 'ws://192.0.2.10:6768',
      deviceToken: 'second-token'
    })
    expect(closeRemoteRuntimeRequestConnectionMock).toHaveBeenCalledWith(saved.id)
  })

  it('does not stamp a refresh that a newer one overtook with its stale verification', async () => {
    registerRuntimeEnvironmentHandlers(store as never)
    const saved = environmentStore.addEnvironmentFromPairingCode(userDataPath, {
      name: 'desk',
      pairingCode: pairingCode('ws://100.76.32.125:6768')
    })
    sendRemoteRuntimeRequestMock.mockResolvedValue({
      id: 'status',
      ok: true,
      result: runtimeStatus(),
      _meta: { runtimeId: 'runtime-a' }
    })
    // An overlapping re-add lands while this one retires the old connection.
    let overtaken = false
    closeRemoteRuntimeRequestConnectionMock.mockImplementation(() => {
      const current = environmentStore.resolveEnvironmentPairingOffer(userDataPath, saved.id)
      if (overtaken || current.deviceToken !== 'second-token') {
        return
      }
      overtaken = true
      // The newer pairing answers as another process, so only a stale stamp reads runtime-a.
      const newer = { ...runtimeStatus(), runtimeId: 'runtime-b' }
      for (const mock of [
        sendRemoteRuntimeRequestMock,
        sendRemoteRuntimeSharedControlRequestMock
      ]) {
        mock.mockResolvedValue({
          id: 'status',
          ok: true,
          result: newer,
          _meta: { runtimeId: 'runtime-b' }
        })
      }
      environmentStore.addOrUpdateEnvironmentFromPairingCode(userDataPath, {
        name: 'desk',
        pairingCode: pairingCode('ws://192.0.2.11:6768', { deviceToken: 'third-token' }),
        now: Date.now() + 60_000
      })
    })
    const verifyAndAdd = handler<{ name: string; pairingCode: string }, { ok: boolean }>(
      'runtimeEnvironments:verifyAndAddFromPairingCode'
    )

    await verifyAndAdd(null, {
      name: 'desk again',
      pairingCode: pairingCode('ws://192.0.2.10:6768', { deviceToken: 'second-token' })
    })

    expect(overtaken).toBe(true)
    const snapshot = getRuntimeEnvironmentStatusSnapshots().find(
      (entry) => entry.environmentId === saved.id
    )
    expect(snapshot).toBeDefined()
    expect(['runtime-b', undefined]).toContain(snapshot?.status?.runtimeId)
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
      'Choose another one under New projects open on before removing it.'
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
    const getSnapshots = handler<undefined, RuntimeHostStatusSnapshot[]>(
      'runtimeEnvironments:getStatusSnapshots'
    )
    // A new renderer only has the snapshot read, not the earlier disconnect event.
    expect(await getSnapshots(null, undefined)).toMatchObject([
      { environmentId: added.environment.id, retired: true, transport: 'disconnected' }
    ])
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
    expect(await getSnapshots(null, undefined)).toMatchObject([
      { environmentId: added.environment.id, verification: 'verified' }
    ])
    expect((await getSnapshots(null, undefined))[0].retired).not.toBe(true)
  })

  it('marks environments owned by ephemeral VM runtimes in the public list', async () => {
    registerRuntimeEnvironmentHandlers(store as never)

    // Provisioning records ephemeral-vm source directly; listing must not depend on the VM runtime store.
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
