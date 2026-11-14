import type { RelayReconnectController } from '../relay/mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { ForegroundNudgeReason } from './connection-state'

export class MobileEndpointNudgeRouter {
  // Undefined until read, so a join before the first read still counts as a change.
  private lastLocalNetwork: string | null | undefined
  // Reads can settle out of order; a result older than the last applied one is stale.
  private readsStarted = 0
  private lastAppliedRead = 0

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      isStopped: () => boolean
      isForeground: () => boolean
      setForeground: (foreground: boolean) => void
      scheduleDirectProbe: () => void
      readLocalNetwork: () => Promise<string | null>
      onLocalNetworkArrival: () => void
    }
  ) {
    void args.readLocalNetwork().then(
      (network) => {
        // Once a nudge reads, this result may predate its network, so it can't be the baseline.
        if (this.readsStarted === 0) {
          this.lastLocalNetwork = network
        }
      },
      () => {}
    )
  }

  nudge(reason: ForegroundNudgeReason): void {
    const { args } = this
    if (args.isStopped()) {
      return
    }
    if (!args.isForeground()) {
      // Background handoffs must not reopen billed relay splices; focus/resume imply visibility even before AppState catches up.
      if (reason === 'network-change') {
        return
      }
      args.setForeground(true)
    }
    args.controller.handleActiveNudge(args.logical, reason)
    if (reason !== 'network-change') {
      args.scheduleDirectProbe()
    }
    // The phone usually joins home Wi-Fi in a pocket, so a resume can be the first sight of the new network.
    if (reason !== 'focus') {
      void this.routeNetworkChange()
    }
  }

  // iOS repeats callbacks for an unchanged network; only a move onto a new Wi-Fi network is an arrival.
  private async routeNetworkChange(): Promise<void> {
    const read = ++this.readsStarted
    let network: string | null
    try {
      network = await this.args.readLocalNetwork()
    } catch {
      // Keep the baseline: a failed read isn't a move.
      if (!this.args.isStopped()) {
        this.args.scheduleDirectProbe()
      }
      return
    }
    if (read < this.lastAppliedRead || this.args.isStopped()) {
      return
    }
    this.lastAppliedRead = read
    if (network === this.lastLocalNetwork) {
      return
    }
    this.lastLocalNetwork = network
    if (network === null) {
      this.args.scheduleDirectProbe()
    } else {
      this.args.onLocalNetworkArrival()
    }
  }
}
