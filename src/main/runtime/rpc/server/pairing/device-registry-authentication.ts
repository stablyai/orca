import type { AuthorizationIncarnation } from '../../../../../shared/authorization-incarnation'
import { DeviceRegistrySightings } from './device-registry-sightings'
import {
  isExchangeSignIn,
  planForkedTicketRetirement,
  planTicketExchange,
  promoteExchangedTicket
} from './pairing-ticket-exchange'
import {
  lookupDeviceKeyRow,
  type AuthenticatedPrincipalBinding,
  type DeviceEntry,
  type DeviceKeyLookup
} from './device-entry'
import { DeviceRegistryUnavailableError } from './device-registry-unavailable'

export class DeviceRegistryAuthentication extends DeviceRegistrySightings {
  validateToken(token: string): DeviceEntry | null {
    this.requireAuthority()
    this.authorityIndex.expire(this.devices)
    const device = this.authorityIndex.token(token)
    if (!device || !isExchangeSignIn(device, token)) {
      return device
    }
    try {
      return this.retirePairingToken(device)
    } catch (error) {
      if (error instanceof DeviceRegistryUnavailableError && error.reason === 'conflict') {
        const current = this.authorityIndex.token(token)
        if (!current) {
          return null
        }
        if (current.token === token) {
          return current
        }
      }
      throw error
    }
  }

  /** Durable before the reply, so a client that stores the replacement can always sign in with it. */
  exchangePairingTicket(deviceId: string, presentedToken: string, exchangeToken: string): void {
    this.requireAuthority()
    const next = planTicketExchange(this.devices, deviceId, presentedToken, exchangeToken)
    this.devices = this.save(next, { durable: true, guards: [deviceId] })
    if (this.authorityIndex.row(deviceId)?.exchangeToken !== exchangeToken) {
      throw new DeviceRegistryUnavailableError('conflict', null)
    }
  }

  /** After an authenticated key sign-in; a failed write is retried on the next one. */
  retireForkedTicket(
    signedInDeviceId: string,
    proof?: { principal: AuthenticatedPrincipalBinding; authority?: AuthorizationIncarnation }
  ): void {
    this.requireAuthority({ fresh: true })
    if (
      proof &&
      (!proof.authority ||
        proof.authority.signal.aborted ||
        this.authorityIndex.capture(proof.principal) !== proof.authority)
    ) {
      throw new Error('unauthorized')
    }
    const next = planForkedTicketRetirement(this.devices, signedInDeviceId)
    if (next) {
      this.devices = this.save(next, { durable: true, guards: [signedInDeviceId] })
    }
  }

  /** Persist token promotion before acknowledging authentication; a storage failure is retryable. */
  private retirePairingToken(device: DeviceEntry & { exchangeToken: string }): DeviceEntry | null {
    const promoted = promoteExchangedTicket(device)
    this.devices = this.save(
      this.devices.map((d) => (d === device ? promoted : d)),
      { durable: true }
    )
    const current = this.authorityIndex.token(device.exchangeToken)
    if (current && current.token !== device.exchangeToken) {
      throw new DeviceRegistryUnavailableError('conflict', null)
    }
    return current
  }

  // Clients erase keys on unknown; reserve that verdict for readable absence.
  lookupDeviceKey(deviceId: string): DeviceKeyLookup {
    this.adoptExternalEdits()
    if (this.registryUnreadable) {
      return { kind: 'unavailable' }
    }
    const lookup = lookupDeviceKeyRow(this.authorityIndex.row(deviceId), this.devices)
    return lookup.kind === 'unknown' && (this.registryUnreadable || this.registryDoubtful)
      ? { kind: 'unavailable' }
      : lookup
  }

  resolveAuthenticatedPrincipal(
    principal: AuthenticatedPrincipalBinding,
    authority?: AuthorizationIncarnation
  ): DeviceEntry | null {
    if (authority) {
      return authority.signal.aborted ? null : this.authorityIndex.principal(principal)
    }
    this.refreshAuthority()
    return this.authorityIndex.principal(principal)
  }

  captureAuthority(principal: AuthenticatedPrincipalBinding, deviceToken = principal.deviceToken) {
    return this.authorityIndex.capture({ ...principal, deviceToken })
  }

  validateReadyAuthority(
    principal: AuthenticatedPrincipalBinding,
    authority?: AuthorizationIncarnation
  ): boolean {
    this.requireAuthority({ fresh: true })
    this.authorityIndex.expire(this.devices)
    return (
      authority !== undefined &&
      !authority.signal.aborted &&
      this.authorityIndex.capture(principal) === authority
    )
  }
}
