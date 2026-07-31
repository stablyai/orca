import type { MobileRelayEndpoint } from '../../../src/shared/mobile-relay-credential-contract'
import type { MobileRelayCredentialBundle } from './mobile-relay-credential-bundle'
import { rotateMobileRelayCredential } from './mobile-relay-credential-rotation'
import { persistRelayHost, withEndpointRouteDeadline } from './mobile-endpoint-supervisor-support'
import { MobileRelayUpgradeHostRemovedError } from './host-store'
import type { RpcClient } from './rpc-client'
import type { HostProfile } from './types'

export class MobileRelayHostPersistence {
  constructor(
    private readonly writeBundle: (bundle: MobileRelayCredentialBundle) => Promise<void>,
    private readonly deleteBundle: (hostId: string) => Promise<void>,
    private readonly saveHost: (host: HostProfile) => Promise<void>,
    private readonly randomBytes: (length: number) => Uint8Array,
    private readonly setTimer: typeof setTimeout,
    private readonly clearTimer: typeof clearTimeout
  ) {}

  persist(host: HostProfile, relay: MobileRelayEndpoint, timeoutMs: number): Promise<HostProfile> {
    const publication = persistRelayHost(host, relay, this.saveHost).catch(async (error) => {
      if (error instanceof MobileRelayUpgradeHostRemovedError) {
        await this.deleteBundle(host.id)
      }
      throw error
    })
    return withEndpointRouteDeadline({
      promise: publication,
      timeoutMs,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
  }

  async rotate(args: {
    client: RpcClient
    host: HostProfile
    bundle: MobileRelayCredentialBundle
    shouldContinue: () => boolean
  }): Promise<{ host: HostProfile; bundle: MobileRelayCredentialBundle }> {
    const result = await rotateMobileRelayCredential({
      client: args.client,
      bundle: args.bundle,
      writeBundle: this.writeBundle,
      randomBytes: this.randomBytes,
      shouldContinue: args.shouldContinue
    })
    const host = await this.persist(args.host, result.relay, 12_000)
    return { host, bundle: result.bundle }
  }
}
