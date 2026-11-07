// Per-device revocable tokens isolate compromises; persist with hardened metadata-style permissions.
import type { DeviceScope } from '../../../../../shared/runtime-session-contracts'
import { mintTokenDevice } from './device-credential'
import { planDeviceKeyFork } from './device-key-fork'
import { planIdleEphemeralPrune } from './ephemeral-device-rows'
import { DeviceRegistryStore } from './device-registry-store'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../../../../shared/runtime-pairing-reach'
import type { DelegatedPhone } from '../../../../../shared/delegated-mobile-device-contract'
import {
  planDelegatedMobileDevices,
  type DelegatedMobileDeviceEntry
} from './delegated-mobile-devices'
import type { RuntimeDeviceGrant } from '../../rpc-method-permission'
import { validGrants } from './device-registry-row-validation'
import {
  expiredPairingOffers,
  pendingPairingOffers,
  reusablePairingOffer,
  withoutExpiredUnboundOffers
} from './pairing-offer-expiry'
import {
  mobilePairingConnectionModeOf,
  findPrincipalDevice,
  findTokenDevice,
  type AuthenticatedPrincipalBinding,
  lookupDeviceKeyRow,
  type DeviceEntry,
  type DeviceKeyLookup,
  type TokenDeviceEntry
} from './device-entry'
import type { MobilePushRegistration } from '../../../../../shared/mobile-push-contract'
import type { NetworkSourceClass } from '../../network-source-class'

// Coalesce reconnect bookkeeping: each Windows save otherwise spawns synchronous ACL PowerShell twice.
const LAST_SEEN_FLUSH_DELAY_MS = 250

export class DeviceRegistry extends DeviceRegistryStore {
  /** First sightings this session, kept even when their persist failed. */
  private readonly seenDeviceIds = new Set<string>()

  addDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = [],
    offerTtlMs?: number
  ): TokenDeviceEntry {
    return this.createAndPersistDevice(this.devices, name, scope, pairingReach, grants, offerTtlMs)
  }

  private createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    grants: readonly RuntimeDeviceGrant[],
    offerTtlMs: number | undefined
  ): TokenDeviceEntry {
    const entry = mintTokenDevice(name, scope, pairingReach, grants, offerTtlMs)
    const nextDevices = [...existingDevices, entry]
    // Credentials become valid only after durable persistence.
    this.devices = this.save(nextDevices)
    return entry
  }

  /** Coalesce re-advertisement onto one unused token so repeated QR requests cannot orphan credentials. */
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = [],
    offerTtlMs?: number
  ): TokenDeviceEntry {
    // Never show a QR for an offer an admin removed on disk.
    this.adoptExternalEdits({ fresh: true })
    // Relay-bound rows leave through the caller's discard, which queues the cloud revoke first.
    const live = withoutExpiredUnboundOffers(this.devices, this.seenDeviceIds)
    if (live !== this.devices) {
      this.saveOrLog({}, 'prune expired pairing offers', this.devices, live)
    }
    // Reuse only identical grants so re-advertisement cannot expand permissions.
    const existing = this.getPendingDevice(scope, offerTtlMs, grants)
    if (existing) {
      // Widen advertised reach, never narrow it and break an off-host link already handed out.
      const widen = pairingReach === 'network' && existing.pairingReach === 'this-computer'
      // Removed on disk meanwhile: mint a fresh offer rather than hand out a revoked one.
      const offered = widen ? this.setPairingReach(existing, 'network') : existing
      return offered ?? this.addDevice(name, scope, pairingReach, grants, offerTtlMs)
    }
    return this.addDevice(name, scope, pairingReach, grants, offerTtlMs)
  }

  private setPairingReach(
    existing: TokenDeviceEntry,
    pairingReach: RuntimePairingReach
  ): TokenDeviceEntry | null {
    const updated: TokenDeviceEntry = { ...existing, pairingReach }
    return this.replaceRow(existing.deviceId, () => updated) ? updated : null
  }

  /** Explicit QR regeneration revokes leaked unused offers; ordinary re-advertisement reuses them. */
  rotatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = [],
    offerTtlMs?: number
  ): TokenDeviceEntry {
    // Authentication marks seen before child sync, so pending runtime offers cannot have children.
    const pending = new Set<DeviceEntry>(this.listPendingDevices(scope))
    const retained = this.devices.filter((d) => !pending.has(d))
    return this.createAndPersistDevice(retained, name, scope, pairingReach, grants, offerTtlMs)
  }

  listDelegatedMobileDevices(parentDeviceId: string): DeviceEntry[] {
    return this.devices.filter((device) => device.parentDeviceId === parentDeviceId)
  }

  /** Create-or-return one mobile child per phoneKey under `parent`, in `phones` order. */
  upsertDelegatedMobileDevices(
    parent: DeviceEntry,
    phones: readonly DelegatedPhone[]
  ): DelegatedMobileDeviceEntry[] {
    // Plan over the file as it is: an unchanged child removed on disk would skip the save's merge.
    this.adoptExternalEdits({ fresh: true })
    const { nextDevices, entries } = planDelegatedMobileDevices(this.devices, parent, phones)
    if (nextDevices !== this.devices) {
      this.devices = this.save(nextDevices)
    }
    // A child the file had already lost is dropped by the save: never hand out its token.
    return entries.filter((entry) => this.getDevice(entry.deviceId) !== null)
  }

  removeDevice(deviceId: string): boolean {
    const nextDevices = this.devices.filter((d) => d.deviceId !== deviceId)
    if (nextDevices.length === this.devices.length) {
      return false
    }
    // Persist before swapping memory so failure cannot revoke a device only until restart.
    this.devices = this.save(nextDevices)
    return true
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  /** The offer re-advertisement under `offerTtlMs` would reuse. */
  getPendingDevice(
    scope: DeviceScope = 'mobile',
    offerTtlMs?: number,
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry | null {
    this.adoptExternalEdits({ fresh: true })
    const offers = this.listPendingDevices(scope)
    return reusablePairingOffer(offers, validGrants(grants, scope) ?? [], offerTtlMs)
  }

  listPendingDevices(scope: DeviceScope): TokenDeviceEntry[] {
    return pendingPairingOffers(this.devices, scope, this.seenDeviceIds)
  }

  listExpiredPairingOffers(scope: DeviceScope): DeviceEntry[] {
    return expiredPairingOffers(this.devices, this.seenDeviceIds).filter((d) => d.scope === scope)
  }

  setRelayBinding(deviceId: string, binding: RelayDeviceBinding): boolean {
    return (
      binding.relayDeviceId === deviceId &&
      this.replaceRow(deviceId, (device) => ({ ...device, relayBinding: binding }))
    )
  }

  setPushRegistration(deviceId: string, registration: MobilePushRegistration | null): boolean {
    return (
      this.getDevice(deviceId)?.scope === 'mobile' &&
      this.replaceRow(deviceId, (device) => {
        const { pushRegistration: _dropped, ...rest } = device
        return registration ? { ...rest, pushRegistration: registration } : rest
      })
    )
  }

  setMobilePairingConnectionMode(deviceId: string, mode: MobilePairingConnectionMode): boolean {
    return (
      this.getDevice(deviceId)?.scope === 'mobile' &&
      this.replaceRow(deviceId, (device) => ({ ...device, mobilePairingConnectionMode: mode }))
    )
  }

  getMobilePairingConnectionMode(deviceId: string): MobilePairingConnectionMode | null {
    return mobilePairingConnectionModeOf(this.getDevice(deviceId))
  }

  listDevices(): readonly DeviceEntry[] {
    return this.devices
  }

  validateToken(token: string): DeviceEntry | null {
    this.adoptExternalEdits()
    return findTokenDevice(this.devices, token, this.seenDeviceIds)
  }

  // Clients erase keys on unknown; reserve that verdict for readable absence.
  lookupDeviceKey(deviceId: string): DeviceKeyLookup {
    this.adoptExternalEdits()
    const lookup = lookupDeviceKeyRow(this.getDevice(deviceId), this.devices)
    return lookup.kind === 'unknown' && (this.registryUnreadable || this.registryDoubtful)
      ? { kind: 'unavailable' }
      : lookup
  }

  forkDeviceKey(
    legacyDeviceId: string,
    devicePublicKeyB64: string,
    label: string,
    options: { ephemeral?: boolean } = {}
  ): DeviceEntry {
    const fork = planDeviceKeyFork(
      this.devices,
      legacyDeviceId,
      devicePublicKeyB64,
      label,
      Date.now(),
      options
    )
    if (fork.created) {
      this.devices = this.save(fork.nextDevices, { durable: true })
    }
    return fork.entry
  }

  /** Removal revokes credentials, so pruning must persist durably. */
  pruneIdleEphemeralDevices(now: number, isLive: (deviceId: string) => boolean): string[] {
    const plan = planIdleEphemeralPrune(this.devices, now, isLive)
    if (plan.removed.length > 0) {
      this.devices = this.save(plan.nextDevices, { durable: true })
    }
    return plan.removed
  }

  resolveAuthenticatedPrincipal(principal: AuthenticatedPrincipalBinding): DeviceEntry | null {
    this.adoptExternalEdits()
    return findPrincipalDevice(this.devices, principal)
  }

  updateLastSeen(deviceId: string, sourceClass?: NetworkSourceClass): void {
    // Persist first sighting inline or rotation could delete a paired row still pending on disk.
    this.seenDeviceIds.add(deviceId)
    const seenAt = Date.now()
    this.replaceRow(deviceId, ({ offerExpiresAt: _paired, ...device }) =>
      seen(device, seenAt, sourceClass)
    )
  }

  /** Defer repeat sightings to avoid synchronous Windows ACL saves during E2EE auth.
   * First sighting must persist inline so pending-offer rotation cannot revoke a paired device. */
  updateLastSeenDeferred(deviceId: string, sourceClass?: NetworkSourceClass): void {
    const existing = this.getDevice(deviceId)
    if (!existing || existing.lastSeenAt === 0) {
      return existing ? this.updateLastSeen(deviceId, sourceClass) : undefined
    }
    const seenAt = Date.now()
    this.devices = this.devices.map((device) =>
      device === existing ? seen(device, seenAt, sourceClass) : device
    )
    if (this.pendingLastSeenFlush) {
      return
    }
    this.pendingLastSeenFlush = setTimeout(
      () => this.flushPendingLastSeen(),
      LAST_SEEN_FLUSH_DELAY_MS
    )
    this.pendingLastSeenFlush.unref?.()
  }

  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    // Failed bookkeeping must not terminate the runtime.
    this.saveOrLog({}, 'persist device lastSeen')
  }
}

function seen(device: DeviceEntry, seenAt: number, sourceClass?: NetworkSourceClass): DeviceEntry {
  return { ...device, lastSeenAt: seenAt, ...(sourceClass ? { lastSourceClass: sourceClass } : {}) }
}
