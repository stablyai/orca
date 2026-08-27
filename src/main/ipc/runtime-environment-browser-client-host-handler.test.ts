import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

const {
  handleMock,
  resolveEnvironmentMock,
  getRuntimeEnvironmentStatusMock,
  startHostMock,
  closeHostMock,
  manuallyDisconnectedMock
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  resolveEnvironmentMock: vi.fn(),
  getRuntimeEnvironmentStatusMock: vi.fn(),
  startHostMock: vi.fn(),
  closeHostMock: vi.fn(),
  manuallyDisconnectedMock: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: handleMock } }))
vi.mock('../../shared/runtime-environment-store', () => ({
  resolveEnvironment: resolveEnvironmentMock
}))
vi.mock('./runtime-environment-transport-routing', () => ({
  getRuntimeEnvironmentStatus: getRuntimeEnvironmentStatusMock
}))
vi.mock('../browser/paired-runtime-browser-client-host-runtime', () => ({
  startPairedRuntimeBrowserClientHost: startHostMock,
  closePairedRuntimeBrowserClientHostEnvironment: closeHostMock
}))
vi.mock('./runtime-environment-connectivity-handlers', () => ({
  isRuntimeEnvironmentManuallyDisconnected: manuallyDisconnectedMock
}))

import { registerRuntimeEnvironmentBrowserClientHostHandler } from './runtime-environment-browser-client-host-handler'
import { channelHandlerLookup } from './runtime-environments-ipc-test-harness'

const handler = channelHandlerLookup(handleMock)

describe('runtime environment browser client host handler', () => {
  beforeEach(() => {
    handleMock.mockReset()
    resolveEnvironmentMock.mockReset()
    resolveEnvironmentMock.mockReturnValue(environment())
    getRuntimeEnvironmentStatusMock.mockReset()
    getRuntimeEnvironmentStatusMock.mockResolvedValue({
      id: 'status.get',
      ok: true,
      result: {
        runtimeId: 'runtime-a',
        rendererGraphEpoch: 1,
        graphStatus: 'ready',
        authoritativeWindowId: 1,
        liveTabCount: 0,
        liveLeafCount: 0,
        capabilities: [
          BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
          BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
          BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
          BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
          BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
        ]
      },
      _meta: { runtimeId: 'runtime-a' }
    })
    startHostMock.mockReset()
    startHostMock.mockResolvedValue({
      authorityRuntimeId: 'runtime-a',
      authorityEpoch: 'epoch-a',
      browserHostClientId: 'browser-client-a',
      browserHostGeneration: 1
    })
    closeHostMock.mockReset()
    closeHostMock.mockResolvedValue(true)
    manuallyDisconnectedMock.mockReset()
    manuallyDisconnectedMock.mockReturnValue(false)
  })

  it('prepares the exact capable host through a fresh main-process status probe', async () => {
    register(true)

    const prepare = handler<
      { selector: string; expectedPairingRevision: number },
      { kind: 'client'; browserHostClientId: string }
    >('runtimeEnvironments:prepareBrowserClientHostPlacement')

    await expect(
      prepare(null, { selector: 'environment-a', expectedPairingRevision: 7 })
    ).resolves.toEqual({ kind: 'client', browserHostClientId: 'browser-client-a' })
    expect(getRuntimeEnvironmentStatusMock).toHaveBeenCalledWith('/profile', 'environment-a')
    expect(startHostMock).toHaveBeenCalledWith({
      environment: expect.objectContaining({ id: 'environment-a', pairingRevision: 7 }),
      authorityRuntimeId: 'runtime-a'
    })
  })

  it('honors the default-on main-side kill switch only for new preparation', async () => {
    register(false)

    const prepare = handler<{ selector: string }, { kind: 'server' }>(
      'runtimeEnvironments:prepareBrowserClientHostPlacement'
    )

    await expect(prepare(null, { selector: 'environment-a' })).resolves.toEqual({ kind: 'server' })
    expect(getRuntimeEnvironmentStatusMock).not.toHaveBeenCalled()
    expect(startHostMock).not.toHaveBeenCalled()
    expect(closeHostMock).not.toHaveBeenCalled()
  })

  it('leaves an attached host untouched and routes only later preparations to server', async () => {
    let enabled = true
    registerRuntimeEnvironmentBrowserClientHostHandler({
      getUserDataPath: () => '/profile',
      getSettings: () => ({ browserClientHostedRemoteEnabled: enabled })
    })
    const prepare = handler<{ selector: string }, { kind: 'client' | 'server' }>(
      'runtimeEnvironments:prepareBrowserClientHostPlacement'
    )

    await expect(prepare(null, { selector: 'environment-a' })).resolves.toMatchObject({
      kind: 'client'
    })
    enabled = false
    await expect(prepare(null, { selector: 'environment-a' })).resolves.toEqual({
      kind: 'server'
    })

    expect(startHostMock).toHaveBeenCalledOnce()
    expect(closeHostMock).not.toHaveBeenCalled()
  })

  it('answers server placement when the fresh probe never reaches the host', async () => {
    getRuntimeEnvironmentStatusMock.mockResolvedValue({
      id: 'status.get',
      ok: false,
      error: { code: 'runtime_unavailable', message: 'socket closed before ready' },
      _meta: { runtimeId: 'runtime-a' }
    })
    register(true)
    const prepare = handler<{ selector: string }, { kind: string }>(
      'runtimeEnvironments:prepareBrowserClientHostPlacement'
    )

    // A create that would have gone server-side anyway must not fail because the probe it now
    // always makes could not complete.
    await expect(prepare(null, { selector: 'environment-a' })).resolves.toEqual({ kind: 'server' })
    expect(startHostMock).not.toHaveBeenCalled()
  })

  // Why this guard carries the case alone now: a probe that cannot answer resolves to server
  // placement instead of throwing, so nothing else notices that the user detached the runtime
  // while it was in flight.
  it('rejects a manual disconnect that lands while the probe is in flight', async () => {
    getRuntimeEnvironmentStatusMock.mockImplementation(async () => {
      manuallyDisconnectedMock.mockReturnValue(true)
      return {
        id: 'status.get',
        ok: false,
        error: { code: 'runtime_unavailable', message: 'disconnected mid-probe' },
        _meta: { runtimeId: 'runtime-a' }
      }
    })
    register(true)
    const prepare = handler<{ selector: string }, unknown>(
      'runtimeEnvironments:prepareBrowserClientHostPlacement'
    )

    await expect(prepare(null, { selector: 'environment-a' })).rejects.toThrow(
      'runtime_manually_disconnected'
    )
    expect(startHostMock).not.toHaveBeenCalled()
  })

  it('rejects manual disconnect before probing or attaching', async () => {
    manuallyDisconnectedMock.mockReturnValue(true)
    register(true)
    const prepare = handler<{ selector: string }, unknown>(
      'runtimeEnvironments:prepareBrowserClientHostPlacement'
    )

    await expect(prepare(null, { selector: 'environment-a' })).rejects.toThrow(
      'runtime_manually_disconnected'
    )
    expect(getRuntimeEnvironmentStatusMock).not.toHaveBeenCalled()
    expect(startHostMock).not.toHaveBeenCalled()
  })

  it('rejects malformed requests before resolving stored pairing authority', async () => {
    register(true)
    const prepare = handler<unknown, unknown>(
      'runtimeEnvironments:prepareBrowserClientHostPlacement'
    )

    await expect(prepare(null, { selector: '' })).rejects.toThrow()
    expect(resolveEnvironmentMock).not.toHaveBeenCalled()
  })
})

function register(enabled: boolean): void {
  registerRuntimeEnvironmentBrowserClientHostHandler({
    getUserDataPath: () => '/profile',
    getSettings: () => ({ browserClientHostedRemoteEnabled: enabled })
  })
}

function environment(): KnownRuntimeEnvironment {
  return {
    id: 'environment-a',
    name: 'Environment A',
    createdAt: 1,
    updatedAt: 7,
    pairingRevision: 7,
    pairedDeviceId: 'device-a',
    lastUsedAt: null,
    runtimeId: 'runtime-a',
    endpoints: [
      {
        id: 'endpoint-a',
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: 'ws://runtime-a.test',
        deviceToken: 'token-a',
        publicKeyB64: 'key-a'
      }
    ],
    preferredEndpointId: 'endpoint-a'
  }
}
