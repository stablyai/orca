import type { DeviceEntry, DeviceRegistry } from '../device-registry'
import type { RelayDeviceBinding, RelayRevokeOutbox } from './relay-revoke-outbox'

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

/**
 * Run a demand refresh as the wake signal it is.
 *
 * A refresh reaches the device registry (`nextPendingExpiry` -> `listDevices`) and the settings
 * store (`hasDemand` -> the host pairing mode), so it can fail on its own. Bare, it failed the
 * caller it was waking for: before an operation it threw with a transient ref already acquired —
 * and those have no expiry, so the ref held relay demand for the rest of the process — and after
 * one it replaced the operation's own result, turning a named mint failure into an unrelated
 * message and a successful mint into a rejection. A lost wake signal is recoverable; the liveness
 * tick and the next refresh both re-ask.
 */
export function refreshRelayDemandBestEffort(refresh: () => void): void {
  try {
    refresh()
  } catch (error) {
    console.warn('[relay] demand refresh failed:', error)
  }
}

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
      // Keep this guard even though nothing can reach it today: `released` makes the lookup happen
      // at most once per closure and no public path empties the map, so mutating it away survives
      // the suite. It goes load-bearing the moment the ledger grows a dispose()/clear(), and
      // nothing would catch that.
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
    // KNOWN GAP, deliberately not fixed here: a transient ref carries no owner identity, so this
    // loop answers true for ANY signed-in identity. The device-binding and revoke-outbox branches
    // below both filter on `ownerIdentityKey`; this one cannot. A profile/org switch mid-pairing
    // therefore keeps the coordinator holding a relay control session for an identity that never
    // asked for one.
    //
    // Nothing defends either the current behaviour or that regression: scoping this loop by owner
    // fails exactly one test across the whole relay suite, the characterisation test written for
    // it. The fix has to thread identity through `acquireTransient`, whose call site is
    // desktop-relay-service.ts. Inferring the owner here instead — skipping a ref whose device
    // carries a different owner's binding — is UNSAFE: `withTransientDemand('provision')` calls
    // `setMobileRelayBinding` inside the operation, so during a re-pair the device still holds the
    // old owner's binding and that filter would drop demand mid-provision, tearing the broker down
    // under the very operation holding the ref.
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
      const binding = this.demandCandidateBinding(device)
      if (!binding || binding.ownerIdentityKey !== ownerIdentityKey) {
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
      // Why: an expiry that hasDemand would never look at still armed a wake
      // timer — another host's binding, a runtime device, a LAN-excluded phone.
      const expiresAt = this.demandCandidateBinding(device)?.inviteExpiresAt
      if (expiresAt && expiresAt > now && (next === null || expiresAt < next)) {
        next = expiresAt
      }
    }
    return next
  }

  /** Test-only view of the outstanding transient refs. */
  transientRefsForTests(): ReadonlyMap<string, Readonly<TransientRef>> {
    return this.transientRefs
  }

  /** The binding when this device could stand as demand on this relay host, else null. */
  private demandCandidateBinding(device: DeviceEntry): RelayDeviceBinding | null {
    const binding = device.relayBinding
    if (
      device.scope !== 'mobile' ||
      !binding ||
      binding.relayHostId !== this.options.relayHostId ||
      !this.isRelayAllowed(device.deviceId)
    ) {
      return null
    }
    return binding
  }

  private isRelayAllowed(deviceId: string): boolean {
    return this.options.isRelayAllowedForDevice?.(deviceId) ?? true
  }
}
