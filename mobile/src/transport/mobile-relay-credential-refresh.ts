import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import { persistRelayHost } from './mobile-endpoint-supervisor-support'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { RelayReconnectController } from './mobile-relay-reconnect-controller'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export class MobileRelayCredentialRefresh {
  private inFlight = false

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      controller: RelayReconnectController
      dependencies: MobileEndpointSupervisorDependencies
      bundle: () => MobileRelayCredentialBundle | null
      host: () => HostProfile
      adoptBundle: (bundle: MobileRelayCredentialBundle) => void
      adoptHost: (host: HostProfile) => void
      isStopped: () => boolean
      isForeground: () => boolean
      recoverRelay: () => void
    }
  ) {}

  async run(force = false): Promise<void> {
    const { args } = this
    const bundle = args.bundle()
    if (
      args.isStopped() ||
      this.inFlight ||
      !bundle ||
      args.logical.getActivePath() === 'relay' ||
      (!force && !mobileRelayCredentialNeedsRotation(bundle, args.dependencies.now()))
    ) {
      return
    }
    this.inFlight = true
    let refreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: args.logical,
        bundle,
        writeBundle: args.dependencies.writeBundle,
        randomBytes: args.dependencies.randomBytes
      })
      if (args.isStopped()) {
        return
      }
      args.adoptBundle(result.bundle)
      refreshed = true
      const host = await persistRelayHost(args.host(), result.relay, args.dependencies.saveHost)
      args.adoptHost(host)
    } catch {
      // Pending material remains durable for the next authenticated direct opportunity.
    } finally {
      if (refreshed) {
        args.controller.completeCredentialRefresh()
      }
      this.inFlight = false
      if (
        refreshed &&
        !args.isStopped() &&
        args.isForeground() &&
        args.controller.needsRecovery(args.logical.getState())
      ) {
        args.recoverRelay()
      }
    }
  }
}
