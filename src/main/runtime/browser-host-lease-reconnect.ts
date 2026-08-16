import type { BrowserClientHostedPageInventory } from '../../shared/browser-client-host-protocol'
import type {
  BrowserHostLeaseHandle,
  BrowserHostLeaseState,
  BrowserHostRouteState
} from './browser-host-lease-records'
import type { BrowserHostFenceReason } from './browser-host-lease-fence'
import { createBrowserHostFence } from './browser-host-lease-fence'

type BrowserHostReconnectAttach = {
  connectionId: string
  hostCapabilities: readonly string[]
  pageCommandProtocolVersion?: 1
  pageReconciliationProtocolVersion?: 1
  leaseReconnectProtocolVersion?: 1
}

type BrowserHostLeaseReconnectControllerOptions = {
  graceMs: number
  leasesByClientId: Map<string, BrowserHostLeaseState>
  fenceReconciliation(state: BrowserHostLeaseState): void
  fenceLease(state: BrowserHostLeaseState, reason: BrowserHostFenceReason): void
  fenceRoute(state: BrowserHostRouteState, reason: BrowserHostFenceReason): void
}

export class BrowserHostLeaseReconnectController {
  constructor(private readonly options: BrowserHostLeaseReconnectControllerOptions) {
    if (!Number.isInteger(options.graceMs) || options.graceMs < 1) {
      throw new Error('browser_host_reconnect_grace_invalid')
    }
  }

  createHandle(state: BrowserHostLeaseState): BrowserHostLeaseHandle {
    const connectionToken = state.connectionToken
    return {
      lease: state.lease,
      whenFenced: state.fence.promise,
      whenConnectionSuperseded: state.connectionFence.promise.then(() => undefined),
      disconnect: () => this.disconnect(state, connectionToken),
      release: () => this.release(state, connectionToken)
    }
  }

  restore(
    state: BrowserHostLeaseState,
    input: BrowserHostReconnectAttach,
    pageInventory: readonly BrowserClientHostedPageInventory[] | undefined
  ): BrowserHostLeaseHandle | undefined {
    if (
      (state.status !== 'active' && state.status !== 'reconnecting') ||
      state.lease.leaseReconnectProtocolVersion !== 1 ||
      input.leaseReconnectProtocolVersion !== 1 ||
      state.lease.pageCommandProtocolVersion !== input.pageCommandProtocolVersion ||
      state.lease.pageReconciliationProtocolVersion !== input.pageReconciliationProtocolVersion ||
      !sameCapabilities(state.lease.hostCapabilities, input.hostCapabilities)
    ) {
      return undefined
    }
    if (state.status === 'active') {
      for (const route of state.routes) {
        this.options.fenceRoute(route, 'lease_released')
      }
      state.commandLedger?.detachDelivery()
    }
    this.clear(state)
    state.connectionFence.resolve('replaced')
    state.connectionFence = createBrowserHostFence()
    state.connectionToken = Symbol(input.connectionId)
    state.lease = Object.freeze({
      ...state.lease,
      connectionId: input.connectionId,
      hostCapabilities: Object.freeze([...input.hostCapabilities]),
      pageInventoryProtocolVersion: 1,
      pageInventory: pageInventory ?? Object.freeze([])
    })
    state.status = 'active'
    return this.createHandle(state)
  }

  clear(state: BrowserHostLeaseState): void {
    if (!state.reconnectTimer) {
      return
    }
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = undefined
  }

  private disconnect(state: BrowserHostLeaseState, connectionToken: symbol): void {
    if (
      this.options.leasesByClientId.get(state.lease.browserHostClientId) !== state ||
      state.connectionToken !== connectionToken ||
      state.status !== 'active'
    ) {
      return
    }
    if (state.lease.leaseReconnectProtocolVersion !== 1) {
      this.options.fenceLease(state, 'released')
      return
    }
    state.status = 'reconnecting'
    this.options.fenceReconciliation(state)
    for (const route of state.routes) {
      this.options.fenceRoute(route, 'lease_released')
    }
    state.reconnectTimer = setTimeout(
      () => this.options.fenceLease(state, 'released'),
      this.options.graceMs
    )
  }

  private release(state: BrowserHostLeaseState, connectionToken: symbol): void {
    if (state.connectionToken === connectionToken) {
      this.options.fenceLease(state, 'released')
    }
  }
}

function sameCapabilities(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((capability, index) => capability === right[index])
  )
}
