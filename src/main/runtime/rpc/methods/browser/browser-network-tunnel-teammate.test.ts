// A teammate's own pages send their network through the host, on their own page-host lease only.
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import type { BrowserNetworkExecutionRouteResolver } from '../../../../browser/network/execution-routes/browser-network-execution-route-contract'
import '../../../../../shared/remote-runtime/protocol/protocol-version'
import {
  BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
  BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
} from '../../../../../shared/browser/runtime/browser-runtime-capabilities'
import { getBrowserHostLeaseRegistry } from '../../../browser-host/leases/browser-host-lease-registry-instance'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { BrowserNetworkTunnelOutboundMemoryBudgetRegistry } from '../../../../browser/network/tunnels/browser-network-tunnel-outbound-memory-budget'
import { RpcDispatcher } from '../../dispatcher'
import { callerScopeOf } from '../../server/pairing/device-principal'
import { createBrowserNetworkTunnelMethods } from './browser-network-tunnel'

let hostRuntime: OrcaRuntimeService
let resolveExecutionRoute: Mock<BrowserNetworkExecutionRouteResolver>
let dispatcher: RpcDispatcher

beforeEach(() => {
  vi.stubEnv('ORCA_TEST_PAIRED_DEVICE_AS_TEAMMATE', '1')
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the tunnel method and lease registry read only these accessors.
  hostRuntime = {
    getRuntimeId: () => 'runtime-a',
    getStartedAt: () => 1,
    registerSubscriptionCleanup: () => {}
  } as unknown as OrcaRuntimeService
  // Past admission and the lease check, the route lookup is where a tunnel starts.
  resolveExecutionRoute = vi.fn<BrowserNetworkExecutionRouteResolver>(async () => {
    throw new Error('route_lookup_reached')
  })
  dispatcher = new RpcDispatcher({
    runtime: hostRuntime,
    methods: createBrowserNetworkTunnelMethods(
      new BrowserNetworkTunnelOutboundMemoryBudgetRegistry(),
      resolveExecutionRoute
    )
  })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const lease = (browserHostClientId: string, pairedDeviceId: string) =>
  getBrowserHostLeaseRegistry(hostRuntime).attach({
    browserHostClientId,
    connectionId: `${pairedDeviceId}-control`,
    pairedDeviceId,
    hostCapabilities: ['webview']
  }).lease

async function tunnelAsTeammate(owned: ReturnType<typeof lease>): Promise<string> {
  const replies: string[] = []
  await dispatcher.dispatchStreaming(
    {
      id: 'tunnel',
      authToken: '',
      method: 'network.browserTunnel',
      params: {
        authorityRuntimeId: 'runtime-a',
        authorityEpoch: owned.authorityEpoch,
        browserHostClientId: owned.browserHostClientId,
        browserHostGeneration: owned.browserHostGeneration,
        executionHost: { kind: 'native', runtimeId: 'runtime-a', revision: 1 }
      }
    },
    (reply) => replies.push(reply),
    {
      callerScope: callerScopeOf({
        deviceId: 'desk-b',
        name: 'Desk B',
        scope: 'runtime',
        pairedAt: 0,
        lastSeenAt: 0
      }),
      connectionId: 'desk-b-connection',
      clientKind: 'runtime',
      pairedDeviceId: 'desk-b',
      clientCapabilities: [
        BROWSER_CLIENT_HOST_RUNTIME_CAPABILITY,
        BROWSER_NETWORK_TUNNEL_RUNTIME_CAPABILITY
      ],
      sendBinary: vi.fn(() => true),
      registerBinaryMessageHandler: vi.fn(() => () => {})
    }
  )
  return JSON.parse(replies[0]!).error.message
}

it('opens a tunnel on the teammate’s own lease, never on another computer’s', async () => {
  const others = lease('host-owner', 'desk-owner')
  expect(await tunnelAsTeammate(others)).toBe('browser_host_lease_stale')
  expect(resolveExecutionRoute).not.toHaveBeenCalled()

  // Admitted and on its own lease: it reaches the route lookup, which this stand-in fails.
  expect(await tunnelAsTeammate(lease('host-b', 'desk-b'))).toBe(
    'browser_tunnel_execution_host_unavailable'
  )
  expect(resolveExecutionRoute).toHaveBeenCalledOnce()
})
