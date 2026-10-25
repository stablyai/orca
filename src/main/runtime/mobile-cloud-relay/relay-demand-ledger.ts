import type { DeviceRegistry } from '../device-registry'
import type { RelayRevokeOutbox } from './relay-revoke-outbox'

type RelayDemandLedgerOptions = {
  deviceRegistry: DeviceRegistry
  revokeOutbox: RelayRevokeOutbox
  relayHostId: string
  now?: () => number
}

export class RelayDemandLedger {
  private readonly options: RelayDemandLedgerOptions
  private readonly transientRefs = new Map<string, number>()

  constructor(options: RelayDemandLedgerOptions) {
    this.options = options
  }

  acquireTransient(key: string): () => void {
    this.transientRefs.set(key, (this.transientRefs.get(key) ?? 0) + 1)
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const count = this.transientRefs.get(key) ?? 0
      if (count <= 1) {
        this.transientRefs.delete(key)
      } else {
        this.transientRefs.set(key, count - 1)
      }
    }
  }

  hasDemand(ownerIdentityKey: string): boolean {
    if (this.transientRefs.size > 0) {
      return true
    }
    if (this.options.revokeOutbox.pendingFor(ownerIdentityKey, this.options.relayHostId).length) {
      return true
    }
    const now = (this.options.now ?? Date.now)()
    return this.options.deviceRegistry.listDevices().some((device) => {
      const binding = device.relayBinding
      if (
        device.scope !== 'mobile' ||
        !binding ||
        binding.ownerIdentityKey !== ownerIdentityKey ||
        binding.relayHostId !== this.options.relayHostId
      ) {
        return false
      }
      // Why: E2EE authentication marks a scanned DeviceEntry as seen before
      // relay credential install commits. Only removing the invite expiry at
      // the durable install boundary promotes it to standing device demand.
      return binding.inviteExpiresAt === undefined || binding.inviteExpiresAt > now
    })
  }

  nextPendingExpiry(): number | null {
    const now = (this.options.now ?? Date.now)()
    let next: number | null = null
    for (const device of this.options.deviceRegistry.listDevices()) {
      const expiresAt = device.relayBinding?.inviteExpiresAt
      if (expiresAt && expiresAt > now && (next === null || expiresAt < next)) {
        next = expiresAt
      }
    }
    return next
  }
}
