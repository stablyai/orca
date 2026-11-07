// Per-device revocable tokens isolate compromises; persist with hardened metadata-style permissions.
import { withDeviceSighting, type DeviceSightingFraming } from './device-sighting'
import type { DeviceScope } from '../../../../../shared/runtime-session-contracts'
import { mintTokenDevice } from './device-credential'
import { planDeviceKeyFork } from './device-key-fork'
import {
  isExchangeSignIn,
  planForkedTicketRetirement,
  planTicketExchange,
  promoteExchangedTicket
} from './pairing-ticket-exchange'
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
// Unpersisted, a restart would refuse and prune a signed-in row as an expired unused offer.
const FIRST_SIGHTING_RETRY_MS = 60_000

export class DeviceRegistry extends DeviceRegistryStore {
  /** First sightings this session, kept even when their persist failed. */
  private readonly seenDeviceIds = new Set<string>()
  private firstSightingRetryPending = false

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
    const device = findTokenDevice(this.devices, token, this.seenDeviceIds)
    return device && isExchangeSignIn(device, token) ? this.retirePairingToken(device) : device
  }

  /** Durable before the reply, so a client that stores the replacement can always sign in with it. */
  exchangePairingTicket(deviceId: string, presentedToken: string, exchangeToken: string): void {
    this.adoptExternalEdits()
    const next = planTicketExchange(this.devices, deviceId, presentedToken, exchangeToken)
    this.devices = this.save(next, { durable: true })
  }

  /** After an authenticated key sign-in; a failed write is retried on the next one. */
  retireForkedTicket(signedInDeviceId: string): void {
    const next = planForkedTicketRetirement(this.devices, signedInDeviceId)
    if (next) {
      this.saveOrLog(
        { durable: true },
        'retire a pairing code a browser replaced',
        this.devices,
        next
      )
    }
  }

  /** First sign-in with the replacement; a failed write keeps both tokens and retries next sign-in. */
  private retirePairingToken(device: DeviceEntry & { exchangeToken: string }): DeviceEntry {
    const promoted = promoteExchangedTicket(device)
    try {
      this.devices = this.save(
        this.devices.map((d) => (d === device ? promoted : d)),
        { durable: true }
      )
      return this.getDevice(device.deviceId) ?? promoted
    } catch (error) {
      console.error('[runtime] Failed to retire an exchanged pairing token:', error)
      return {
        ...device,
        token: device.exchangeToken,
        callerFingerprint: promoted.callerFingerprint
      }
    }
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

  updateLastSeen(
    deviceId: string,
    sourceClass?: NetworkSourceClass,
    framing?: DeviceSightingFraming
  ): void {
    // Persist first sighting inline or rotation could delete a paired row still pending on disk.
    this.seenDeviceIds.add(deviceId)
    const seenAt = Date.now()
    const sight = ({ offerExpiresAt: _paired, ...device }: DeviceEntry): DeviceEntry => {
      const firstSighting =
        device.ticket === true && device.lastSeenAt === 0
          ? { ...device, ticketFirstSeenAt: seenAt }
          : device
      return withDeviceSighting(seen(firstSighting, seenAt, sourceClass), seenAt, framing)
    }
    try {
      this.replaceRow(deviceId, sight)
    } catch (error) {
      // Keep the sighting in memory so any later save writes it, and retry until one lands.
      this.devices = this.devices.map((d) => (d.deviceId === deviceId ? sight(d) : d))
      this.firstSightingRetryPending = true
      this.scheduleLastSeenFlush(FIRST_SIGHTING_RETRY_MS)
      throw error
    }
  }

  /** Defer repeat sightings to avoid synchronous Windows ACL saves during E2EE auth.
   * First sighting must persist inline so pending-offer rotation cannot revoke a paired device. */
  updateLastSeenDeferred(
    deviceId: string,
    sourceClass?: NetworkSourceClass,
    framing?: DeviceSightingFraming
  ): void {
    const existing = this.getDevice(deviceId)
    if (!existing || existing.lastSeenAt === 0) {
      return existing ? this.updateLastSeen(deviceId, sourceClass, framing) : undefined
    }
    const seenAt = Date.now()
    this.devices = this.devices.map((device) =>
      device === existing
        ? withDeviceSighting(seen(device, seenAt, sourceClass), seenAt, framing)
        : device
    )
    this.scheduleLastSeenFlush(LAST_SEEN_FLUSH_DELAY_MS)
  }

  private scheduleLastSeenFlush(delayMs: number): void {
    if (!this.pendingLastSeenFlush) {
      this.pendingLastSeenFlush = setTimeout(() => this.flushPendingLastSeen(), delayMs)
      this.pendingLastSeenFlush.unref?.()
    }
  }

  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    // Failed bookkeeping must not terminate the runtime.
    try {
      this.devices = this.save(this.devices)
      this.firstSightingRetryPending = false
    } catch (error) {
      console.error('[runtime] Failed to persist device lastSeen:', error)
      if (this.firstSightingRetryPending) {
        this.scheduleLastSeenFlush(FIRST_SIGHTING_RETRY_MS)
      }
    }
  }
}

function seen(device: DeviceEntry, seenAt: number, sourceClass?: NetworkSourceClass): DeviceEntry {
  return { ...device, lastSeenAt: seenAt, ...(sourceClass ? { lastSourceClass: sourceClass } : {}) }
}
