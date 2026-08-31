import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type { BrowserExecutionHostGrantRegistry } from './browser-execution-host-grant-registry'
import type { BrowserHostCommandLedger } from './browser-host-command-ledger'
import type { BrowserHostFence, BrowserHostFenceReason } from './browser-host-lease-fence'

const MAX_BROWSER_HOSTS_PER_CONNECTION = 1
// Why: tolerate brief desktop restart overlap while keeping one paired identity bounded.
const MAX_BROWSER_HOSTS_PER_PAIRED_DEVICE = 4

export type BrowserHostLease = Readonly<{
  authorityRuntimeId: string
  authorityEpoch: string
  browserHostClientId: string
  browserHostGeneration: number
  connectionId: string
  pairedDeviceId: string
  hostCapabilities: readonly string[]
  pageCommandProtocolVersion?: 1
  pageInventoryProtocolVersion?: 1
  pageReconciliationProtocolVersion?: 1
  leaseReconnectProtocolVersion?: 1
  fileChannelProtocolVersion?: 1
  pageInventory?: readonly BrowserClientHostedPageInventory[]
}>

export type BrowserHostLeaseIdentity = Pick<
  BrowserHostLease,
  'authorityEpoch' | 'browserHostClientId' | 'browserHostGeneration' | 'pairedDeviceId'
>

export type BrowserHostCommandResultIdentity = BrowserHostLeaseIdentity &
  Pick<BrowserHostLease, 'connectionId'>

export type BrowserHostLeaseState = {
  token: symbol
  connectionToken: symbol
  connectionFence: BrowserHostFence
  lease: BrowserHostLease
  status: 'active' | 'reconnecting'
  reconnectTimer?: ReturnType<typeof setTimeout>
  fence: BrowserHostFence
  routes: Set<BrowserHostRouteState>
  executionHostGrants: BrowserExecutionHostGrantRegistry
  commandLedger?: BrowserHostCommandLedger
}

export type BrowserHostRouteState = {
  token: symbol
  lease: BrowserHostLeaseState
  key: string
  tunnelGeneration: number
  fence: BrowserHostFence
  releaseGrantLink?: () => void
}

export type BrowserHostLeaseHandle = Readonly<{
  lease: BrowserHostLease
  whenFenced: Promise<BrowserHostFenceReason>
  whenConnectionSuperseded: Promise<void>
  disconnect: () => void
  release: () => void
}>

export type BrowserTunnelLeaseHandle = Readonly<{
  tunnelGeneration: number
  whenFenced: Promise<BrowserHostFenceReason>
  release: () => void
}>

export function assertBrowserHostLeaseAdmission(
  states: Iterable<BrowserHostLeaseState>,
  input: { connectionId: string; pairedDeviceId: string },
  replacement: BrowserHostLeaseState | undefined
): void {
  let connectionLeases = 0
  let deviceLeases = 0
  for (const state of states) {
    if (state === replacement) {
      continue
    }
    if (state.lease.connectionId === input.connectionId) {
      connectionLeases += 1
    }
    if (state.lease.pairedDeviceId === input.pairedDeviceId) {
      deviceLeases += 1
    }
  }
  if (connectionLeases >= MAX_BROWSER_HOSTS_PER_CONNECTION) {
    throw new Error('browser_host_connection_capacity')
  }
  if (deviceLeases >= MAX_BROWSER_HOSTS_PER_PAIRED_DEVICE) {
    throw new Error('browser_host_device_capacity')
  }
}

export function requireBrowserHostCommandResultLedger(
  state: BrowserHostLeaseState,
  identity: BrowserHostCommandResultIdentity
): BrowserHostCommandLedger {
  if (state.lease.connectionId !== identity.connectionId) {
    throw new Error('browser_host_lease_stale')
  }
  if (!state.commandLedger) {
    throw new Error('browser_host_command_protocol_required')
  }
  return state.commandLedger
}
