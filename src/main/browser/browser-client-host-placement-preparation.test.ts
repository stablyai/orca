import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../shared/protocol-version'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import type { RuntimeRpcResponse } from '../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../shared/runtime-types'
import { prepareBrowserClientHostPlacement } from './browser-client-host-placement-preparation'

const REQUIRED_CAPABILITIES = [
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_PAGE_METADATA_RUNTIME_CAPABILITY,
  BROWSER_CLIENT_AUTOMATION_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_EXECUTION_HOSTS_RUNTIME_CAPABILITY
] as const

describe('browser client host placement preparation', () => {
  it('starts the exact capable paired host and returns its client identity', async () => {
    const harness = createHarness()

    await expect(harness.prepare()).resolves.toEqual({
      kind: 'client',
      browserHostClientId: 'browser-client-a'
    })
    expect(harness.getStatus).toHaveBeenCalledWith('environment-a')
    expect(harness.startHost).toHaveBeenCalledWith({
      environment: expect.objectContaining({ id: 'environment-a', pairingRevision: 7 }),
      authorityRuntimeId: 'runtime-a'
    })
    expect(harness.closeHost).not.toHaveBeenCalled()
  })

  it.each([
    ['explicit server placement', { preference: 'server' as const, enabled: true }],
    ['disabled new-page switch', { preference: 'auto' as const, enabled: false }]
  ])('keeps %s on the server without probing or starting a client host', async (_label, input) => {
    const harness = createHarness()

    await expect(harness.prepare(input)).resolves.toEqual({ kind: 'server' })
    expect(harness.getStatus).not.toHaveBeenCalled()
    expect(harness.startHost).not.toHaveBeenCalled()
  })

  it('keeps an older host on the server when any required capability is absent', async () => {
    const harness = createHarness({
      status: runtimeStatus({ capabilities: REQUIRED_CAPABILITIES.slice(0, 2) })
    })

    await expect(harness.prepare()).resolves.toEqual({ kind: 'server' })
    expect(harness.startHost).not.toHaveBeenCalled()
  })

  it('keeps a mobile-scoped pairing on the server even when capabilities are advertised', async () => {
    const harness = createHarness({
      status: runtimeStatus({ deviceScope: 'mobile' })
    })

    await expect(harness.prepare()).resolves.toEqual({ kind: 'server' })
    expect(harness.startHost).not.toHaveBeenCalled()
  })

  it('surfaces a capable host start failure without falling back to server placement', async () => {
    const harness = createHarness()
    harness.startHost.mockRejectedValueOnce(new Error('attach failed'))

    await expect(harness.prepare()).rejects.toThrow('attach failed')
    expect(harness.startHost).toHaveBeenCalledTimes(1)
  })

  it('rejects a runtime identity mismatch before starting a client host', async () => {
    const harness = createHarness({
      status: runtimeStatus({}, { responseRuntimeId: 'runtime-b' })
    })

    await expect(harness.prepare()).rejects.toThrow('browser_client_host_runtime_identity_changed')
    expect(harness.startHost).not.toHaveBeenCalled()
  })

  it('rejects a non-ready capable runtime instead of changing placement', async () => {
    const harness = createHarness({ status: runtimeStatus({ graphStatus: 'reloading' }) })

    await expect(harness.prepare()).rejects.toThrow('browser_client_host_runtime_not_ready')
    expect(harness.startHost).not.toHaveBeenCalled()
  })

  it('rejects a pairing change observed after status without starting either identity', async () => {
    const harness = createHarness({
      environments: [environment(7), environment(8)]
    })

    await expect(harness.prepare()).rejects.toThrow('browser_client_host_pairing_changed')
    expect(harness.startHost).not.toHaveBeenCalled()
  })

  it('retires the attached host when its pairing changes before placement is returned', async () => {
    const harness = createHarness({
      environments: [environment(7), environment(7), environment(8)]
    })

    await expect(harness.prepare()).rejects.toThrow('browser_client_host_pairing_changed')
    expect(harness.startHost).toHaveBeenCalledTimes(1)
    expect(harness.closeHost).toHaveBeenCalledWith(
      'environment-a',
      expect.objectContaining({ message: 'browser_client_host_pairing_changed' })
    )
  })

  // Why this replaced a throw: the probe used to run only behind a cached "host can client-host"
  // verdict, so a failed one meant a real problem for a pairing that wanted client hosting. Every
  // create probes now, and a create that would have succeeded on the server must not die with it.
  it.each([
    ['an offline host', 'runtime_unavailable', 'offline'],
    ['a timed-out probe', 'timeout', 'status.get timed out']
  ])('keeps %s on the server instead of failing the create', async (_label, code, message) => {
    const harness = createHarness({
      status: {
        id: 'status.get',
        ok: false,
        error: { code, message },
        _meta: { runtimeId: 'runtime-a' }
      }
    })

    await expect(harness.prepare()).resolves.toEqual({ kind: 'server' })
    expect(harness.startHost).not.toHaveBeenCalled()
    expect(harness.closeHost).not.toHaveBeenCalled()
  })
})

function createHarness(options?: {
  environments?: KnownRuntimeEnvironment[]
  status?: RuntimeRpcResponse<RuntimeStatus>
}) {
  const environments = options?.environments ?? [environment(7), environment(7), environment(7)]
  let environmentIndex = 0
  const resolveEnvironment = vi.fn(() => {
    const resolved = environments[Math.min(environmentIndex, environments.length - 1)]!
    environmentIndex += 1
    return resolved
  })
  const getStatus = vi.fn(async () => options?.status ?? runtimeStatus())
  const startHost = vi.fn(async () => ({
    authorityRuntimeId: 'runtime-a',
    authorityEpoch: 'epoch-a',
    browserHostClientId: 'browser-client-a',
    browserHostGeneration: 1
  }))
  const closeHost = vi.fn(async () => true)
  return {
    getStatus,
    startHost,
    closeHost,
    prepare: (overrides?: { preference?: 'auto' | 'server'; enabled?: boolean }) =>
      prepareBrowserClientHostPlacement({
        selector: 'environment-a',
        expectedPairingRevision: 7,
        preference: overrides?.preference ?? 'auto',
        enabled: overrides?.enabled ?? true,
        resolveEnvironment,
        getStatus,
        startHost,
        closeHost
      })
  }
}

function environment(pairingRevision: number): KnownRuntimeEnvironment {
  return {
    id: 'environment-a',
    name: 'Environment A',
    createdAt: 1,
    updatedAt: pairingRevision,
    pairingRevision,
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

function runtimeStatus(
  overrides: Partial<RuntimeStatus> = {},
  options?: { responseRuntimeId?: string }
): RuntimeRpcResponse<RuntimeStatus> {
  const runtimeId = overrides.runtimeId ?? 'runtime-a'
  return {
    id: 'status.get',
    ok: true,
    result: {
      runtimeId,
      rendererGraphEpoch: 1,
      graphStatus: 'ready',
      authoritativeWindowId: 1,
      liveTabCount: 0,
      liveLeafCount: 0,
      capabilities: [...REQUIRED_CAPABILITIES],
      ...overrides
    },
    _meta: { runtimeId: options?.responseRuntimeId ?? runtimeId }
  }
}
