import { MobileDirectTailnetFallback } from './mobile-direct-tailnet-fallback'
import {
  mobileDirectReturnCandidates,
  type LearnedDirectEndpoints
} from './mobile-direct-return-candidates'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'
import type { RpcClient } from '../rpc/rpc-client-contract'

// The Relay supervisor owns the route set; the existing direct fallback only acts when direct is reconnecting.
export class MobileSupervisorDirectRoutes {
  private endpoints: LearnedDirectEndpoints = {}
  private fallback: MobileDirectTailnetFallback | null = null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly deps: MobileEndpointSupervisorDependencies,
    private readonly isForeground: () => boolean,
    private readonly onLearned: (path: 'lan' | 'tailscale') => void
  ) {}

  learn(path: 'lan' | 'tailscale', endpoint: string): void {
    if (path === 'lan' ? this.learnLan(endpoint) : this.learnTailnet(endpoint)) {
      this.onLearned(path)
    }
  }

  hasRecoveryFallback(): boolean {
    return this.fallback !== null
  }

  private learnTailnet(endpoint: string): boolean {
    if (!this.deps.openTailnetDirect || this.deps.directPath === 'tailscale') {
      return false
    }
    if (this.endpoints.tailnetEndpoint === endpoint) {
      return false
    }
    this.endpoints = { ...this.endpoints, tailnetEndpoint: endpoint }
    this.updateFallback()
    return true
  }

  private learnLan(endpoint: string): boolean {
    if (!this.deps.openLanDirect) {
      return false
    }
    if (this.endpoints.lanEndpoint === endpoint) {
      return false
    }
    this.endpoints = { ...this.endpoints, lanEndpoint: endpoint }
    this.updateFallback()
    return true
  }

  candidates(path: MobileConnectionPath) {
    return mobileDirectReturnCandidates(this.deps, path, this.endpoints)
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

  private updateFallback(): void {
    this.fallback?.stop()
    const routes =
      this.deps.directPath === 'lan'
        ? this.endpoints.tailnetEndpoint && this.deps.openTailnetDirect
          ? (path: 'lan' | 'tailscale'): RpcClient =>
              path === 'lan'
                ? this.endpoints.lanEndpoint
                  ? this.deps.openLanDirect!(this.endpoints.lanEndpoint)
                  : this.deps.openDirect()
                : this.deps.openTailnetDirect!(this.endpoints.tailnetEndpoint!)
          : null
        : this.endpoints.lanEndpoint && this.deps.openLanDirect
          ? (path: 'lan' | 'tailscale'): RpcClient =>
              path === 'tailscale'
                ? this.deps.openDirect()
                : this.deps.openLanDirect!(this.endpoints.lanEndpoint!)
          : null
    this.fallback = routes ? new MobileDirectTailnetFallback(this.logical, routes) : null
    this.fallback?.start()
    this.fallback?.setForeground(this.isForeground())
  }
}
