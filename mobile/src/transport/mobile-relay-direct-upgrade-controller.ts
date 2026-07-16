import type { MobileRelayDirectUpgradeResult } from './mobile-relay-direct-upgrade'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

type Dependencies = {
  upgrade: (
    client: StableLogicalRpcClient,
    host: HostProfile
  ) => Promise<MobileRelayDirectUpgradeResult | null>
  onUpgraded: (result: MobileRelayDirectUpgradeResult) => Promise<void>
}

export class MobileRelayDirectUpgradeController {
  private foreground = true
  private stopped = false
  private inFlight = false
  private unsubscribe: (() => void) | null = null

  constructor(
    private readonly logical: StableLogicalRpcClient,
    private readonly host: HostProfile,
    private readonly dependencies: Dependencies
  ) {}

  async start(): Promise<void> {
    this.unsubscribe = this.logical.onStateChange((state) => {
      if (state === 'connected') {
        void this.tryUpgrade()
      }
    })
    if (this.logical.getState() === 'connected') {
      await this.tryUpgrade()
    }
  }

  setForeground(foreground: boolean): void {
    this.foreground = foreground
    if (foreground && this.logical.getState() === 'connected') {
      void this.tryUpgrade()
    }
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe?.()
    this.unsubscribe = null
  }

  private async tryUpgrade(): Promise<void> {
    if (this.stopped || !this.foreground || this.inFlight) {
      return
    }
    this.inFlight = true
    try {
      const result = await this.dependencies.upgrade(this.logical, this.host)
      if (!result || this.stopped) {
        return
      }
      this.unsubscribe?.()
      this.unsubscribe = null
      await this.dependencies.onUpgraded(result)
    } catch {
      // Why: the journal survives transient auth/control failure; retry only on
      // the next authenticated reconnect or foreground transition.
    } finally {
      this.inFlight = false
    }
  }
}
