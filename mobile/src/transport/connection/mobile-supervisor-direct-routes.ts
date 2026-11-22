import { MobileDirectTailnetFallback } from './mobile-direct-tailnet-fallback'
import { mobileDirectReturnCandidates } from './mobile-direct-return-candidates'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

// The Relay supervisor owns all direct alternatives; no separate connection supervisor is started.
export class MobileSupervisorDirectRoutes {
  private endpoint: string | undefined
  private fallback: MobileDirectTailnetFallback | null = null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly deps: MobileEndpointSupervisorDependencies,
    private readonly isForeground: () => boolean
  ) {}

  learn(endpoint: string): boolean {
    if (!this.deps.openTailnetDirect || this.deps.directPath !== 'lan') {
      return false
    }
    if (this.endpoint === endpoint) {
      return false
    }
    this.endpoint = endpoint
    this.fallback?.stop()
    this.fallback = new MobileDirectTailnetFallback(this.logical, (path) =>
      path === 'tailscale' ? this.deps.openTailnetDirect!(endpoint) : this.deps.openDirect()
    )
    this.fallback.start()
    this.fallback.setForeground(this.isForeground())
    return true
  }

  candidates(path: MobileConnectionPath) {
    return mobileDirectReturnCandidates(this.deps, path, this.endpoint)
  }

  hasCandidates(): boolean {
    return this.candidates(this.logical.getActivePath()).length > 0
  }

  setForeground(value: boolean): void {
    this.fallback?.setForeground(value)
  }

  nudge(): void {
    this.fallback?.nudge()
  }

  stop(): void {
    this.fallback?.stop()
    this.fallback = null
  }
}
