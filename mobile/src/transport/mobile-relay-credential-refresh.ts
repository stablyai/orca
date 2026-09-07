import {
  mobileRelayCredentialNeedsRotation,
  rotateMobileRelayCredential
} from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'

// Mints a replacement relay credential over a live direct connection. That is the
// only moment it can happen: the replacement comes from an authenticated RPC, and
// a phone whose credential the relay has rejected cannot carry one over relay.
export class MobileRelayCredentialRefresh {
  private inFlight = false

  constructor(
    private readonly args: {
      logical: StableLogicalRpcClient
      now: () => number
      randomBytes: (length: number) => Uint8Array
      writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>
      bundle: () => MobileRelayCredentialBundle | null
      adoptBundle: (bundle: MobileRelayCredentialBundle) => void
      persistResolvedRelay: (resolved: MobileRelayEndpoint) => Promise<void>
      isStopped: () => boolean
      // Lifts the controller's fresh-credential gate once the replacement is durable.
      completeRefresh: () => void
      onRefreshed: () => void
    }
  ) {}

  // force: the caller already knows the current credential is rejected, so the
  // age check would only delay a rotation the relay path is blocked on.
  async run(force: boolean): Promise<void> {
    const { args } = this
    const bundle = args.bundle()
    if (
      args.isStopped() ||
      this.inFlight ||
      !bundle ||
      args.logical.getActivePath() === 'relay' ||
      (!force && !mobileRelayCredentialNeedsRotation(bundle, args.now()))
    ) {
      return
    }
    this.inFlight = true
    let refreshed = false
    try {
      const result = await rotateMobileRelayCredential({
        client: args.logical,
        bundle,
        writeBundle: args.writeBundle,
        randomBytes: args.randomBytes
      })
      args.adoptBundle(result.bundle)
      // Why: a scheduled rotation can finish after the old credential enters the rejection gate.
      refreshed = true
      await args.persistResolvedRelay(result.relay)
    } catch {
      // Why: pending material remains durable; the next authenticated direct
      // opportunity must reconcile it before creating another install key.
    } finally {
      if (refreshed) {
        args.completeRefresh()
      }
      this.inFlight = false
      if (refreshed) {
        args.onRefreshed()
      }
    }
  }
}
