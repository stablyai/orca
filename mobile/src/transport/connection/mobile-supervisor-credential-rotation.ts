import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from '../relay/mobile-relay-credential-rotation'
import type { MobileRelaySessionEstablisher } from '../relay/mobile-relay-session-establisher'
import type { RelayReconnectController } from '../relay/mobile-relay-reconnect-controller'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'

// Relay credential renewal is independent of the supervisor's direct path-selection policy.
export class MobileSupervisorCredentialRotation {
  private inFlight = false

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      dependencies: MobileEndpointSupervisorDependencies
      relayReconnect: RelayReconnectController
      sessionEstablisher: MobileRelaySessionEstablisher
      currentBundle: () => MobileRelayCredentialBundle | null
      updateBundle: (bundle: MobileRelayCredentialBundle) => void
      isActive: () => boolean
      isStopped: () => boolean
      recoverRelay: () => void
    }
  ) {}

  async rotateIfNeeded(force = false): Promise<void> {
    const { args } = this
    const bundle = args.currentBundle()
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
    let credentialRefreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: args.logical,
        bundle,
        writeBundle: args.dependencies.writeBundle,
        randomBytes: args.dependencies.randomBytes
      })
      args.updateBundle(result.bundle)
      // A refresh can land while the previous credential is in the rejection gate.
      credentialRefreshed = true
      await args.sessionEstablisher.adoptRelay(result.relay)
    } catch {
      // Retain pending material for direct reconciliation before another install attempt.
    } finally {
      if (credentialRefreshed) {
        args.relayReconnect.completeCredentialRefresh()
      }
      this.inFlight = false
      if (
        credentialRefreshed &&
        args.isActive() &&
        args.relayReconnect.needsRecovery(args.logical.getState())
      ) {
        args.recoverRelay()
      }
    }
  }
}
