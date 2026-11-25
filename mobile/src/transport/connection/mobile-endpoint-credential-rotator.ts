import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from '../relay/mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from '../../host-credentials/mobile-relay-credential-bundle'
import type { MobileRelayEndpoint } from '../../../../src/shared/remote-runtime/relay/mobile-relay-credential-contract'
import type { MobileEndpointSupervisorDependencies } from './mobile-endpoint-supervisor-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

/** Rotates the Relay credential over a live direct connection, one rotation at a time. */
export class MobileEndpointCredentialRotator {
  private inFlight = false

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      dependencies: Pick<
        MobileEndpointSupervisorDependencies,
        'now' | 'writeBundle' | 'randomBytes'
      >
      isStopped: () => boolean
      bundle: () => MobileRelayCredentialBundle | null
      adoptBundle: (bundle: MobileRelayCredentialBundle) => void
      adoptRelay: (relay: MobileRelayEndpoint) => Promise<void>
      completeCredentialRefresh: () => void
      // Called once a refreshed credential lands while Relay recovery is still needed.
      recoverIfNeeded: () => void
    }
  ) {}

  async rotateIfNeeded(force = false): Promise<void> {
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
    let credentialRefreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: args.logical,
        bundle,
        writeBundle: args.dependencies.writeBundle,
        randomBytes: args.dependencies.randomBytes
      })
      args.adoptBundle(result.bundle)
      // Why: a scheduled rotation can finish after the old credential enters the rejection gate.
      credentialRefreshed = true
      await args.adoptRelay(result.relay)
    } catch {
      // Retain pending material for direct reconciliation before generating another install key.
    } finally {
      if (credentialRefreshed) {
        args.completeCredentialRefresh()
      }
      this.inFlight = false
      if (credentialRefreshed) {
        args.recoverIfNeeded()
      }
    }
  }
}
