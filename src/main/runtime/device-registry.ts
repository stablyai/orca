// Per-device revocable tokens isolate compromises; persist with hardened metadata-style permissions.
import { join } from 'node:path'
import type { DeviceScope } from '../../shared/runtime-types'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { mintTokenDevice } from './device-credential'
import { planDeviceKeyFork } from './device-key-fork'
import { planIdleEphemeralPrune, withoutEphemeralRows } from './ephemeral-device-rows'
import { DeviceRegistryWriter } from './device-registry-disk-merge'
import type { RelayDeviceBinding } from './mobile-cloud-relay/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../shared/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../shared/runtime-pairing-reach'
import type { DelegatedPhone } from '../../shared/delegated-mobile-device-contract'
import {
  planDelegatedMobileDevices,
  type DelegatedMobileDeviceEntry
} from './delegated-mobile-devices'
import type { RuntimeDeviceGrant } from './rpc/rpc-method-permission'
import { validGrants } from './device-registry-row-validation'
import {
  isPendingTokenRow,
  mobilePairingConnectionModeOf,
  findPrincipalDevice,
  findTokenDevice,
  type AuthenticatedPrincipalBinding,
  lookupDeviceKeyRow,
  sameGrants,
  type DeviceEntry,
  type DeviceKeyLookup,
  type TokenDeviceEntry
} from './device-entry'
import type { MobilePushRegistration } from '../../shared/mobile-push-contract'

export type { DeviceScope }

export type { DeviceEntry, DeviceKeyLookup, TokenDeviceEntry }

// Coalesce reconnect bookkeeping: each Windows save otherwise spawns synchronous ACL PowerShell twice.
const LAST_SEEN_FLUSH_DELAY_MS = 250
const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []
  /** Never overwrite an unreadable registry from the empty in-memory list. */
  private registryUnreadable = false
  /** Parse failures prevent authoritative absence/revocation verdicts. */
  private registryDoubtful = false
  private corruptFilePending = false
  private pendingLastSeenFlush: NodeJS.Timeout | null = null
  private readonly writer: DeviceRegistryWriter

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    this.writer = new DeviceRegistryWriter(this.registryPath)
    // #20497: reap temp files orphaned by a crash before rename.
    void removeStaleDurableWriteTempFiles(this.registryPath, {
      minimumAgeMs: STALE_WRITE_TEMP_AGE_MS
    })
    this.load()
  }

  addDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry {
    return this.createAndPersistDevice(this.devices, name, scope, pairingReach, grants)
  }

  private createAndPersistDevice(
    existingDevices: DeviceEntry[],
    name: string,
    scope: DeviceScope,
    pairingReach: RuntimePairingReach,
    grants: readonly RuntimeDeviceGrant[]
  ): TokenDeviceEntry {
    const entry = mintTokenDevice(name, scope, pairingReach, grants)
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
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry {
    // Never show a QR for an offer an admin removed on disk.
    this.adoptExternalEdits()
    // Reuse only identical grants so re-advertisement cannot expand permissions.
    const existing = this.devices.find(
      (d): d is TokenDeviceEntry =>
        isPendingTokenRow(d) && d.scope === scope && sameGrants(d, validGrants(grants, scope) ?? [])
    )
    if (existing) {
      // Widen advertised reach, never narrow it and break an off-host link already handed out.
      const widen = pairingReach === 'network' && existing.pairingReach === 'this-computer'
      // Removed on disk meanwhile: mint a fresh offer rather than hand out a revoked one.
      const offered = widen ? this.setPairingReach(existing, 'network') : existing
      return offered ?? this.addDevice(name, scope, pairingReach, grants)
    }
    return this.addDevice(name, scope, pairingReach, grants)
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
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry {
    // Authentication marks seen before child sync, so pending runtime offers cannot have children.
    const retainedDevices = this.devices.filter((d) => !isPendingTokenRow(d) || d.scope !== scope)
    return this.createAndPersistDevice(retainedDevices, name, scope, pairingReach, grants)
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
    this.adoptExternalEdits()
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

  getPendingDevice(scope: DeviceScope = 'mobile'): TokenDeviceEntry | null {
    this.adoptExternalEdits()
    return (
      this.devices.find(
        (device): device is TokenDeviceEntry => isPendingTokenRow(device) && device.scope === scope
      ) ?? null
    )
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
    return findTokenDevice(this.devices, token)
  }

  // Clients erase keys on unknown; reserve that verdict for readable absence.
  lookupDeviceKey(deviceId: string): DeviceKeyLookup {
    this.adoptExternalEdits()
    const lookup = lookupDeviceKeyRow(this.getDevice(deviceId))
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

  updateLastSeen(deviceId: string): void {
    // Persist first sighting inline or rotation could delete a paired row still pending on disk.
    const seenAt = Date.now()
    this.replaceRow(deviceId, (device) => ({ ...device, lastSeenAt: seenAt }))
  }

  /** Defer repeat sightings to avoid synchronous Windows ACL saves during E2EE auth.
   * First sighting must persist inline so pending-offer rotation cannot revoke a paired device. */
  updateLastSeenDeferred(deviceId: string): void {
    const existing = this.getDevice(deviceId)
    if (!existing || existing.lastSeenAt === 0) {
      return existing ? this.updateLastSeen(deviceId) : undefined
    }
    const seenAt = Date.now()
    this.devices = this.devices.map((device) =>
      device === existing ? { ...device, lastSeenAt: seenAt } : device
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

  private saveOrLog(options: { durable?: boolean }, action: string, before = this.devices): void {
    try {
      this.devices = this.save(this.devices, options, before)
    } catch (error) {
      console.error(`[runtime] Failed to ${action}:`, error)
    }
  }

  private cancelPendingLastSeenFlush(): void {
    if (this.pendingLastSeenFlush) {
      clearTimeout(this.pendingLastSeenFlush)
      this.pendingLastSeenFlush = null
    }
  }

  /** Auth checks see a removal made on disk (an admin revoke) without waiting for orcad's next save. */
  private adoptExternalEdits(): void {
    // An unreadable load refuses everything until restart; there is nothing to merge into.
    if (!this.registryUnreadable) {
      this.devices = this.writer.adoptExternalEdits(this.devices) ?? this.devices
    }
  }

  private load(): void {
    const read = this.writer.read()
    this.registryUnreadable = read.unreadable
    this.registryDoubtful = read.doubtful
    this.corruptFilePending = read.corruptFilePending
    this.devices = withoutEphemeralRows(read.devices)
    // Session-only browser keys died with the prior host; remove their registry rows.
    if (this.devices.length !== read.devices.length) {
      this.saveOrLog({ durable: true }, 'drop session-only devices after restart', read.devices)
    }
  }

  // Persist before memory swap so failed writes cannot diverge authorization state.
  private replaceRow(deviceId: string, update: (device: DeviceEntry) => DeviceEntry): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1) {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? update(device) : device
    )
    this.devices = this.save(nextDevices)
    // False when the file had already lost the row: the update did not apply.
    return this.devices.some((candidate) => candidate.deviceId === deviceId)
  }

  private assertReadable(): void {
    if (this.registryUnreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.registryPath}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    if (this.corruptFilePending) {
      this.writer.quarantineCorrupt()
      this.corruptFilePending = false
    }
  }

  /** Writes `devices` merged over the file as it is now; memory takes the result. */
  private save(
    devices: readonly DeviceEntry[],
    options: { durable?: boolean } = {},
    before: readonly DeviceEntry[] = this.devices
  ): DeviceEntry[] {
    this.assertReadable()
    const written = this.writer.write(before, devices, options)
    // Every save includes current timestamps, making a pending refresh redundant.
    this.cancelPendingLastSeenFlush()
    return written
  }
}
