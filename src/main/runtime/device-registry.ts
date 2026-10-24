// Why: per-device tokens replace the shared runtime auth token for WebSocket
// (mobile) connections. Each paired device gets its own revocable token so
// compromising one device doesn't expose others. The registry is a simple
// JSON file with hardened permissions matching the runtime metadata pattern.
import { join } from 'node:path'
import { writeDurableSecureJsonFile, writeSecureJsonFile } from '../../shared/secure-file'
import type { DeviceScope } from '../../shared/runtime-types'
import { removeStaleDurableWriteTempFiles } from '../durable-file-write'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'
import { mintDeviceCredential } from './device-credential'
import { planDeviceKeyFork } from './device-key-fork'
import { planIdleEphemeralPrune, withoutEphemeralRows } from './ephemeral-device-rows'
import { quarantineCorruptRegistry } from './device-registry-corruption'
import { readDeviceRegistryFile } from './device-registry-file-read'
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
  isStillAuthenticated,
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

// Why: a lastSeen refresh is pure bookkeeping, so coalesce reconnect bursts into one write instead of
// paying a secure-file rewrite (two synchronous PowerShell ACL spawns on Windows) per connection.
const LAST_SEEN_FLUSH_DELAY_MS = 250
const STALE_WRITE_TEMP_AGE_MS = 24 * 60 * 60 * 1000

export class DeviceRegistry {
  private readonly registryPath: string
  private devices: DeviceEntry[] = []
  /** Set when the registry exists but could not be read, which makes `devices` a lie to save from. */
  private registryUnreadable = false
  /** A parse failure, now or in an earlier run, means an unlisted device may still exist. */
  private registryDoubtful = false
  private corruptFilePending = false
  private pendingLastSeenFlush: NodeJS.Timeout | null = null

  constructor(userDataPath: string) {
    this.registryPath = join(userDataPath, DEVICE_REGISTRY_FILENAME)
    // Why: a write killed between writeFile and rename (e.g. a crash mid-write, #20497) orphans its temp forever.
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
    const validatedGrants = validGrants(grants, scope)
    const entry: TokenDeviceEntry = {
      ...mintDeviceCredential(),
      name,
      scope,
      pairedAt: Date.now(),
      lastSeenAt: 0,
      pairingReach,
      ...(validatedGrants ? { grants: validatedGrants } : {})
    }
    const nextDevices = [...existingDevices, entry]
    // Why: a credential is not valid until its durable registry write succeeds.
    this.save(nextDevices)
    this.devices = nextDevices
    return entry
  }

  // Why: coalesce repeated QR-regenerate clicks onto a single pending token.
  // Each call to addDevice() produces a valid auth credential; without
  // coalescing, every renderer call to mobile:getPairingQR (e.g. the new
  // copy-button flow that encourages regeneration) leaves an orphaned token
  // forever. Returns an existing never-scanned entry if present; otherwise
  // mints a new one and drops any stale pending entries.
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry {
    // Why: a pending token is reused only for the same grants, so re-advertising never widens one.
    const existing = this.devices.find(
      (d): d is TokenDeviceEntry =>
        isPendingTokenRow(d) && d.scope === scope && sameGrants(d, validGrants(grants, scope) ?? [])
    )
    if (existing) {
      // Why: the same pending token can be re-advertised at a broader reach; widen it but never narrow it,
      // or a link already handed out for off-host use would stop being served after the next launch.
      return pairingReach === 'network' && existing.pairingReach === 'this-computer'
        ? this.setPairingReach(existing, 'network')
        : existing
    }
    return this.addDevice(name, scope, pairingReach, grants)
  }

  private setPairingReach(
    existing: TokenDeviceEntry,
    pairingReach: RuntimePairingReach
  ): TokenDeviceEntry {
    const updated: TokenDeviceEntry = { ...existing, pairingReach }
    this.replaceRow(existing.deviceId, () => updated)
    return updated
  }

  // Why: explicit rotation path for "Regenerate QR" — invalidates any
  // existing never-scanned token (e.g. one that was screenshotted, copied
  // to clipboard, or shown on a screen-share) and mints a fresh one. Without
  // this, getOrCreatePendingDevice keeps returning the same token forever
  // until a phone actually pairs, so users have no way to revoke a leaked
  // pre-pairing token.
  rotatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry {
    // Why: a pending runtime device has no delegated children — its first auth sets lastSeenAt before any sync.
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
    const { nextDevices, entries } = planDelegatedMobileDevices(this.devices, parent, phones)
    if (nextDevices !== this.devices) {
      this.save(nextDevices)
      this.devices = nextDevices
    }
    return entries
  }

  removeDevice(deviceId: string): boolean {
    const nextDevices = this.devices.filter((d) => d.deviceId !== deviceId)
    if (nextDevices.length === this.devices.length) {
      return false
    }
    // Why: persist before memory swap so a failed write does not drop a device
    // only in-process while disk still lists it (and vice versa on reload).
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  getDevice(deviceId: string): DeviceEntry | null {
    return this.devices.find((d) => d.deviceId === deviceId) ?? null
  }

  getPendingDevice(scope: DeviceScope = 'mobile'): TokenDeviceEntry | null {
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

  /** Passing null clears the registration (unregister, or a token the gateway reported dead). */
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
    return (
      (token && this.devices.find((d) => d.credentialKind === undefined && d.token === token)) ||
      null
    )
  }

  // Why: "unknown" must mean "readable and absent" — clients delete their key only on that verdict.
  lookupDeviceKey(deviceId: string): DeviceKeyLookup {
    const lookup = lookupDeviceKeyRow(this.getDevice(deviceId))
    return lookup.kind === 'unknown' && (this.registryUnreadable || this.registryDoubtful)
      ? { kind: 'unavailable' }
      : lookup
  }

  /** Forks `legacyDeviceId` into a keyed row; durable before it returns (security transition). */
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
      this.save(fork.nextDevices, { durable: true })
      this.devices = fork.nextDevices
    }
    return fork.entry
  }

  /** Drops idle session-only rows; durable, since a removed row is a revocation. */
  pruneIdleEphemeralDevices(now: number, isLive: (deviceId: string) => boolean): string[] {
    const plan = planIdleEphemeralPrune(this.devices, now, isLive)
    if (plan.removed.length > 0) {
      this.save(plan.nextDevices, { durable: true })
      this.devices = plan.nextDevices
    }
    return plan.removed
  }

  /** The row an authenticated socket is still entitled to, or null once revoked or re-credentialed. */
  resolveAuthenticatedPrincipal(principal: AuthenticatedPrincipalBinding): DeviceEntry | null {
    const device = this.getDevice(principal.deviceId)
    return device && isStillAuthenticated(device, principal) ? device : null
  }

  updateLastSeen(deviceId: string): void {
    // Why: a failed write must not leave a scanned device never-scanned on disk, where rotation drops it.
    const seenAt = Date.now()
    this.replaceRow(deviceId, (device) => ({ ...device, lastSeenAt: seenAt }))
  }

  /**
   * Marks a device seen without blocking the caller on disk — the E2EE auth handshake runs this, and on
   * Windows every save spawns PowerShell synchronously to reapply the registry's ACL.
   * The first-ever sighting still persists inline: rotatePendingDevice drops entries that disk says were
   * never scanned, so only that 0 -> non-zero transition is load-bearing.
   */
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
    // Why: bookkeeping must never hold the process open.
    this.pendingLastSeenFlush.unref?.()
  }

  /** Persists a deferred lastSeen refresh now; no-op when nothing is pending. */
  flushPendingLastSeen(): void {
    if (!this.pendingLastSeenFlush) {
      return
    }
    this.cancelPendingLastSeenFlush()
    // Why: matches the async hardening path — a failed bookkeeping write must not take down the runtime.
    this.saveOrLog({}, 'persist device lastSeen')
  }

  private saveOrLog(options: { durable?: boolean }, action: string): void {
    try {
      this.save(this.devices, options)
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

  private load(): void {
    const read = readDeviceRegistryFile(this.registryPath)
    this.registryUnreadable = read.unreadable
    this.registryDoubtful = read.doubtful
    this.corruptFilePending = read.corruptFilePending
    this.devices = withoutEphemeralRows(read.devices)
    // Why: a session-only browser's key died with the last host process; its row must not outlive it.
    if (this.devices.length !== read.devices.length) {
      this.saveOrLog({ durable: true }, 'drop session-only devices after restart')
    }
  }

  // Why: persist before the memory swap so a failed write never leaves memory claiming what disk lacks.
  private replaceRow(deviceId: string, update: (device: DeviceEntry) => DeviceEntry): boolean {
    const index = this.devices.findIndex((candidate) => candidate.deviceId === deviceId)
    if (index === -1) {
      return false
    }
    const nextDevices = this.devices.map((device, candidateIndex) =>
      candidateIndex === index ? update(device) : device
    )
    this.save(nextDevices)
    this.devices = nextDevices
    return true
  }

  private assertReadable(): void {
    if (this.registryUnreadable) {
      throw new Error(
        `Cannot read the device registry at ${this.registryPath}: the read failed. Refusing to overwrite it, which would revoke every paired device.`
      )
    }
    if (this.corruptFilePending) {
      quarantineCorruptRegistry(this.registryPath)
      this.corruptFilePending = false
    }
  }

  // Why: durable (fsync'd) for security transitions such as a device-key fork.
  private save(devices: DeviceEntry[], options: { durable?: boolean } = {}): void {
    this.assertReadable()
    const write = options.durable ? writeDurableSecureJsonFile : writeSecureJsonFile
    write(this.registryPath, devices)
    // Why: every registry save includes the latest in-memory timestamps, so a later timer would rewrite it.
    this.cancelPendingLastSeenFlush()
  }
}
