import { mobileRelayCredentialNeedsRotation } from './mobile-relay-credential-rotation'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import type { MobileRelayHostPersistence } from './mobile-relay-host-persistence'
import type { StableLogicalRpcClient } from './stable-logical-rpc-client'
import type { HostProfile } from './types'

export class MobileRelayCredentialRotationController {
  private inFlight = false

  constructor(
    private readonly client: StableLogicalRpcClient,
    private readonly persistence: MobileRelayHostPersistence,
    private readonly getHost: () => HostProfile,
    private readonly getBundle: () => MobileRelayCredentialBundle | null,
    private readonly apply: (result: {
      host: HostProfile
      bundle: MobileRelayCredentialBundle
    }) => void,
    private readonly shouldContinue: () => boolean,
    private readonly now: () => number
  ) {}

  async rotateIfNeeded(): Promise<void> {
    const bundle = this.getBundle()
    if (
      this.inFlight ||
      !this.shouldContinue() ||
      !bundle ||
      this.client.getActivePath() === 'relay' ||
      !mobileRelayCredentialNeedsRotation(bundle, this.now())
    ) {
      return
    }
    this.inFlight = true
    try {
      this.apply(
        await this.persistence.rotate({
          client: this.client,
          host: this.getHost(),
          bundle,
          shouldContinue: this.shouldContinue
        })
      )
    } catch {
      // Pending credential state remains durable for the next direct route.
    } finally {
      this.inFlight = false
    }
  }
}
