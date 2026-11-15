// Per-device revocable tokens isolate compromises; persist with hardened metadata-style permissions.
import type { AuthorizationIncarnation } from '../../../../../shared/authorization-incarnation'
import type { DeviceScope } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { mintTokenDevice } from './device-credential'
import { planDeviceKeyFork } from './device-key-fork'
import { planIdleEphemeralPrune } from './ephemeral-device-rows'
import { DeviceRegistryAuthentication } from './device-registry-authentication'
import type { RelayDeviceBinding } from '../../../mobile-cloud-relay/pairing/relay-revoke-outbox'
import type { MobilePairingConnectionMode } from '../../../../../shared/remote-runtime/pairing/mobile-pairing-connection-mode'
import type { RuntimePairingReach } from '../../../../../shared/remote-runtime/pairing/runtime-pairing-reach'
import type { DelegatedPhone } from '../../../../../shared/delegated-mobile-device-contract'
import {
  planDelegatedMobileDevices,
  type DelegatedMobileDeviceEntry
} from './delegated-mobile-devices'
import type { RuntimeDeviceGrant } from '../../callers/rpc-method-permission'
import { validGrants } from './device-registry-row-validation'
import {
  expiredPairingOffers,
  pendingPairingOffers,
  reusablePairingOffer,
  withoutExpiredUnboundOffers
} from './pairing-offer-expiry'
import {
  mobilePairingConnectionModeOf,
  type DeviceEntry,
  type AuthenticatedPrincipalBinding,
  type TokenDeviceEntry
} from './device-entry'
import type { MobilePushRegistration } from '../../../../../shared/mobile-push-contract'
import { DeviceRegistryUnavailableError } from './device-registry-unavailable'
import { sameDeviceSecurity, isDeviceFirstSighting } from './device-registry-reconciliation'

export class DeviceRegistry extends DeviceRegistryAuthentication {
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
    const persisted = this.authorityIndex.token(entry.token)
    if (!persisted || persisted.deviceId !== entry.deviceId) {
      throw new DeviceRegistryUnavailableError('conflict', null)
    }
    return { ...persisted, token: entry.token }
  }

  /** Coalesce re-advertisement onto one unused token so repeated QR requests cannot orphan credentials. */
  getOrCreatePendingDevice(
    name: string,
    scope: DeviceScope = 'mobile',
    pairingReach: RuntimePairingReach = 'network',
    grants: readonly RuntimeDeviceGrant[] = [],
    offerTtlMs?: number
  ): TokenDeviceEntry {
    return this.runAuthorityOperation(() => {
      // Never show a QR for an offer an admin removed on disk.
      this.requireAuthority({ fresh: true })
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
    })
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
    this.requireAuthority({ fresh: true })
    const currentParent = this.getDevice(parent.deviceId)
    if (
      !currentParent ||
      (!sameDeviceSecurity(parent, currentParent) && !isDeviceFirstSighting(parent, currentParent))
    ) {
      return []
    }
    const { nextDevices, entries } = planDelegatedMobileDevices(this.devices, parent, phones)
    if (nextDevices !== this.devices) {
      this.devices = this.save(nextDevices, { guards: [parent.deviceId] })
    }
    // A child the file had already lost is dropped by the save: never hand out its token.
    return entries.flatMap((entry) => {
      const current = this.authorityIndex.token(entry.token)
      return current &&
        current.deviceId === entry.deviceId &&
        current.parentDeviceId === parent.deviceId
        ? [
            {
              ...current,
              token: entry.token,
              parentDeviceId: parent.deviceId,
              phoneKey: entry.phoneKey
            }
          ]
        : []
    })
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
    return this.authorityIndex.row(deviceId)
  }

  /** The offer re-advertisement under `offerTtlMs` would reuse. */
  getPendingDevice(
    scope: DeviceScope = 'mobile',
    offerTtlMs?: number,
    grants: readonly RuntimeDeviceGrant[] = []
  ): TokenDeviceEntry | null {
    this.requireAuthority({ fresh: true })
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

  forkDeviceKey(
    legacyDeviceId: string,
    devicePublicKeyB64: string,
    label: string,
    options: {
      ephemeral?: boolean
      proof?: { principal: AuthenticatedPrincipalBinding; authority?: AuthorizationIncarnation }
    } = {}
  ): DeviceEntry {
    this.requireAuthority({ fresh: true })
    if (
      options.proof &&
      (!options.proof.authority ||
        options.proof.authority.signal.aborted ||
        this.authorityIndex.capture(options.proof.principal) !== options.proof.authority)
    ) {
      throw new Error('unauthorized')
    }
    const fork = planDeviceKeyFork(
      this.devices,
      legacyDeviceId,
      devicePublicKeyB64,
      label,
      Date.now(),
      options
    )
    if (fork.created) {
      // Remembered so the link is never reported as an outdated client once session keys are gone.
      const next = options.ephemeral
        ? fork.nextDevices.map((device) =>
            device.deviceId === legacyDeviceId && device.servesSessionBrowsers !== true
              ? { ...device, servesSessionBrowsers: true as const }
              : device
          )
        : fork.nextDevices
      this.devices = this.save(next, { durable: true, guards: [legacyDeviceId] })
    }
    const result = this.lookupDeviceKey(fork.entry.deviceId)
    if (
      result.kind !== 'found' ||
      result.device.devicePublicKeyB64 !== devicePublicKeyB64 ||
      result.device.forkedFrom !== legacyDeviceId
    ) {
      throw new DeviceRegistryUnavailableError('conflict', null)
    }
    return result.device
  }

  /** Removal revokes credentials, so pruning must persist durably. */
  pruneIdleEphemeralDevices(now: number, isLive: (deviceId: string) => boolean): string[] {
    const plan = planIdleEphemeralPrune(this.devices, now, isLive)
    if (plan.removed.length > 0) {
      this.devices = this.save(plan.nextDevices, { durable: true })
    }
    return plan.removed
  }
}
