import type { DeviceRegistry } from '../device-registry'
import type { RelayRevokeOutbox } from './relay-revoke-outbox'

type RelayDemandLedgerOptions = {
  deviceRegistry: DeviceRegistry
  revokeOutbox: RelayRevokeOutbox
  relayHostId: string
  // Why: the host-level pairing mode is a live policy, not a pair-time record;
  // a device it excludes contributes no demand even with a standing binding.
  isRelayAllowedForDevice?: (deviceId: string) => boolean
  now?: () => number
}

type TransientRef = { deviceId: string; count: number }

export class RelayDemandLedger {
  private readonly options: RelayDemandLedgerOptions
  private readonly transientRefs = new Map<string, TransientRef>()

  constructor(options: RelayDemandLedgerOptions) {
    this.options = options
  }

  acquireTransient(key: string, deviceId: string): () => void {
    const ref = this.transientRefs.get(key)
    if (ref) {
      ref.count += 1
    } else {
      this.transientRefs.set(key, { deviceId, count: 1 })
    }
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      const current = this.transientRefs.get(key)
      if (!current) {
        return
      }
      if (current.count <= 1) {
        this.transientRefs.delete(key)
      } else {
        current.count -= 1
      }
    }
  }

  hasDemand(ownerIdentityKey: string): boolean {
    for (const ref of this.transientRefs.values()) {
      if (this.isRelayAllowed(ref.deviceId)) {
        return true
      }
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
        binding.relayHostId !== this.options.relayHostId ||
        !this.isRelayAllowed(device.deviceId)
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

  private isRelayAllowed(deviceId: string): boolean {
    return this.options.isRelayAllowedForDevice?.(deviceId) ?? true
  }
}
