import { BrowserHostGenerationCounter } from './browser-host-generation-counter'
import { createBrowserHostFence, type BrowserHostFenceReason } from './browser-host-lease-fence'
import { fenceBrowserHostRoute } from './browser-host-lease-fencing'
import type {
  BrowserHostLeaseState,
  BrowserHostRouteState,
  BrowserTunnelLeaseHandle
} from './browser-host-lease-records'

export class BrowserHostTunnelRegistry {
  private readonly generations = new BrowserHostGenerationCounter()
  private readonly routesByKey = new Map<string, BrowserHostRouteState>()

  grantExecutionHost(state: BrowserHostLeaseState, executionHostKey: string) {
    return state.executionHostGrants.grant(executionHostKey)
  }

  requireExecutionHost(state: BrowserHostLeaseState, executionHostKey: string): void {
    state.executionHostGrants.require(executionHostKey)
  }

  linkExecutionHostGrant(
    state: BrowserHostLeaseState,
    executionHostKey: string,
    onRevoked: () => void
  ): () => void {
    return state.executionHostGrants.link(executionHostKey, onRevoked)
  }

  open(
    lease: BrowserHostLeaseState,
    executionHostKey: string,
    options?: { requireExecutionHostGrant?: boolean }
  ): BrowserTunnelLeaseHandle {
    const key = `${lease.lease.browserHostClientId}\u0000${executionHostKey}`
    const existing = this.routesByKey.get(key)
    const tunnelGeneration = this.generations.take('tunnel')
    if (existing) {
      this.fence(existing, 'replaced')
    }
    const state: BrowserHostRouteState = {
      token: Symbol(key),
      lease,
      key,
      tunnelGeneration,
      fence: createBrowserHostFence()
    }
    if (options?.requireExecutionHostGrant) {
      state.releaseGrantLink = lease.executionHostGrants.link(executionHostKey, () =>
        this.fence(state, 'released')
      )
    }
    lease.routes.add(state)
    this.routesByKey.set(key, state)
    return {
      tunnelGeneration: state.tunnelGeneration,
      whenFenced: state.fence.promise,
      release: () => this.fence(state, 'released')
    }
  }

  fence(state: BrowserHostRouteState, reason: BrowserHostFenceReason): void {
    fenceBrowserHostRoute(state, reason, this.routesByKey)
  }
}
