import { MobileDirectTailnetFallback } from './mobile-direct-tailnet-fallback'
import {
  mobileDirectReturnCandidates,
  type LearnedDirectEndpoints
} from './mobile-direct-return-candidates'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileConnectionPath } from './stable-logical-rpc-client'

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
    if (
      !this.deps.openDirectEndpoint ||
      (path === 'tailscale' && this.deps.directPath === 'tailscale')
    ) {
      return
    }
    const key = path === 'lan' ? 'lanEndpoint' : 'tailnetEndpoint'
    if (this.endpoints[key] === endpoint) {
      return
    }
    this.endpoints = { ...this.endpoints, [key]: endpoint }
    this.updateFallback()
    this.onLearned(path)
  }

  hasRecoveryFallback(): boolean {
    return this.fallback !== null
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
    const routes = this.candidates('relay')
    const lan = routes.find((candidate) => candidate.path === 'lan')
    const tailnet = routes.find((candidate) => candidate.path === 'tailscale')
    this.fallback =
      lan && tailnet
        ? new MobileDirectTailnetFallback(this.logical, (path) =>
            path === 'lan' ? lan.open() : tailnet.open()
          )
        : null
    this.fallback?.start()
    this.fallback?.setForeground(this.isForeground())
  }
}
