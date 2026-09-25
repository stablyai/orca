import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import { BrowserHostCommandLedger } from './browser-host-command-ledger'
import { BrowserExecutionHostGrantRegistry } from './browser-execution-host-grant-registry'
import { createBrowserHostFence } from './browser-host-lease-fence'
import type { BrowserHostLeaseState } from './browser-host-lease-records'

export type BrowserHostLeaseAttachInput = {
  browserHostClientId: string
  connectionId: string
  pairedDeviceId: string
  hostCapabilities: readonly string[]
  pageCommandProtocolVersion?: 1
  pageInventoryProtocolVersion?: 1
  pageInventory?: readonly BrowserClientHostedPageInventory[]
  pageReconciliationProtocolVersion?: 1
  leaseReconnectProtocolVersion?: 1
  fileChannelProtocolVersion?: 1
}

export function assertBrowserHostReconnectNegotiation(input: BrowserHostLeaseAttachInput): void {
  if (
    input.leaseReconnectProtocolVersion !== undefined &&
    input.leaseReconnectProtocolVersion !== 1
  ) {
    throw new Error('browser_host_reconnect_protocol_unsupported')
  }
  if (input.leaseReconnectProtocolVersion === 1 && input.pageInventoryProtocolVersion !== 1) {
    throw new Error('browser_host_reconnect_inventory_required')
  }
  if (
    input.pageReconciliationProtocolVersion !== undefined &&
    input.pageReconciliationProtocolVersion !== 1
  ) {
    throw new Error('browser_host_reconciliation_protocol_unsupported')
  }
  if (
    input.pageReconciliationProtocolVersion === 1 &&
    (input.pageCommandProtocolVersion !== 1 || input.pageInventoryProtocolVersion !== 1)
  ) {
    throw new Error('browser_host_reconciliation_protocol_dependencies_required')
  }
  if (input.fileChannelProtocolVersion !== undefined && input.fileChannelProtocolVersion !== 1) {
    throw new Error('browser_host_file_channel_protocol_unsupported')
  }
  if (input.fileChannelProtocolVersion === 1 && input.pageCommandProtocolVersion !== 1) {
    throw new Error('browser_host_file_channel_command_protocol_required')
  }
}

export function createBrowserHostLeaseState(options: {
  authorityRuntimeId: string
  authorityEpoch: string
  generation: number
  input: BrowserHostLeaseAttachInput
  pageInventory: readonly BrowserClientHostedPageInventory[] | undefined
}): BrowserHostLeaseState {
  const { input } = options
  const state: BrowserHostLeaseState = {
    token: Symbol(input.browserHostClientId),
    connectionToken: Symbol(input.connectionId),
    connectionFence: createBrowserHostFence(),
    lease: Object.freeze({
      authorityRuntimeId: options.authorityRuntimeId,
      authorityEpoch: options.authorityEpoch,
      browserHostClientId: input.browserHostClientId,
      browserHostGeneration: options.generation,
      connectionId: input.connectionId,
      pairedDeviceId: input.pairedDeviceId,
      hostCapabilities: Object.freeze([...input.hostCapabilities]),
      ...(input.pageCommandProtocolVersion ? { pageCommandProtocolVersion: 1 as const } : {}),
      ...(options.pageInventory
        ? {
            pageInventoryProtocolVersion: 1 as const,
            pageInventory: options.pageInventory
          }
        : {}),
      ...(input.leaseReconnectProtocolVersion ? { leaseReconnectProtocolVersion: 1 as const } : {}),
      ...(input.pageReconciliationProtocolVersion
        ? { pageReconciliationProtocolVersion: 1 as const }
        : {}),
      ...(input.fileChannelProtocolVersion ? { fileChannelProtocolVersion: 1 as const } : {})
    }),
    status: 'active',
    fence: createBrowserHostFence(),
    routes: new Set(),
    executionHostGrants: new BrowserExecutionHostGrantRegistry()
  }
  if (input.pageCommandProtocolVersion) {
    state.commandLedger = new BrowserHostCommandLedger({
      authority: {
        authorityRuntimeId: state.lease.authorityRuntimeId,
        authorityEpoch: state.lease.authorityEpoch,
        browserHostClientId: state.lease.browserHostClientId,
        browserHostGeneration: state.lease.browserHostGeneration,
        pageCommandProtocolVersion: 1,
        ...(state.lease.pageReconciliationProtocolVersion
          ? { pageReconciliationProtocolVersion: 1 as const }
          : {})
      }
    })
  }
  return state
}
