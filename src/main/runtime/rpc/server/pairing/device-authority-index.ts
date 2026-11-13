import { randomUUID } from 'node:crypto'
import type { AuthorizationIncarnation } from '../../../../../shared/authorization-incarnation'
import {
  isExpiredPairingOffer,
  isStillAuthenticated,
  type AuthenticatedPrincipalBinding,
  type DeviceEntry
} from './device-entry'

type AuthorizedDevice = {
  device: DeviceEntry
  signature: string
  authority: AuthorizationIncarnation
  controller: AbortController
}

function credentialSignature(device: DeviceEntry, parents: AuthorizedDevice[]): string {
  return JSON.stringify([
    device.credentialRevision ?? 0,
    device.credentialKind,
    device.token,
    device.devicePublicKeyB64,
    device.scope,
    [...(device.grants ?? [])].sort(),
    ...parents.map((parent) => parent.authority.id)
  ])
}

/** Publish authority once per registry snapshot; requests only perform indexed lookups. */
export class DeviceAuthorityIndex {
  private rows = new Map<string, DeviceEntry>()
  private authorized = new Map<string, AuthorizedDevice>()
  private tokens = new Map<string, AuthorizedDevice>()
  private nextExpiry = Number.POSITIVE_INFINITY

  publish(devices: readonly DeviceEntry[], now = Date.now()): void {
    const rows = new Map(devices.map((device) => [device.deviceId, device]))
    const next = new Map<string, AuthorizedDevice>()
    const children = new Map<string, string[]>()
    const remaining = new Map<string, number>()
    const ready: DeviceEntry[] = []
    let nextExpiry = Number.POSITIVE_INFINITY
    for (const device of devices) {
      if (isExpiredPairingOffer(device, now)) {
        continue
      }
      if (device.lastSeenAt === 0 && device.offerExpiresAt !== undefined) {
        nextExpiry = Math.min(nextExpiry, device.offerExpiresAt)
      }
      const parents = new Set(
        [device.parentDeviceId, device.forkedFrom].filter((id) => id !== undefined)
      )
      remaining.set(device.deviceId, parents.size)
      if (parents.size === 0) {
        ready.push(device)
      }
      for (const parent of parents) {
        const descendants = children.get(parent) ?? []
        descendants.push(device.deviceId)
        children.set(parent, descendants)
      }
    }
    // Missing ancestors and cycles never enter the ready list, so they have no authority.
    for (let index = 0; index < ready.length; index += 1) {
      const device = ready[index]
      const parents = [device.parentDeviceId, device.forkedFrom]
        .map((id) => (id === undefined ? undefined : next.get(id)))
        .filter((parent) => parent !== undefined)
      const signature = credentialSignature(device, parents)
      const previous = this.authorized.get(device.deviceId)
      // Proposing a replacement keeps current sockets valid until the replacement first signs in.
      const reusable =
        previous?.signature === signature &&
        (!previous.device.exchangeToken || previous.device.exchangeToken === device.exchangeToken)
      const controller = reusable ? previous.controller : new AbortController()
      const authority = reusable
        ? previous.authority
        : { id: randomUUID(), signal: controller.signal }
      next.set(device.deviceId, { device, signature, controller, authority })
      for (const child of children.get(device.deviceId) ?? []) {
        const pending = (remaining.get(child) ?? 0) - 1
        remaining.set(child, pending)
        const row = rows.get(child)
        if (pending === 0 && row) {
          ready.push(row)
        }
      }
    }
    const tokens = new Map<string, AuthorizedDevice>()
    for (const entry of next.values()) {
      if (entry.device.credentialKind === undefined) {
        if (entry.device.token) {
          tokens.set(entry.device.token, entry)
        }
        if (entry.device.exchangeToken) {
          tokens.set(entry.device.exchangeToken, entry)
        }
      }
    }
    const revoked = Array.from(this.authorized.values()).filter(
      (previous) => next.get(previous.device.deviceId)?.authority !== previous.authority
    )
    this.rows = rows
    this.authorized = next
    this.tokens = tokens
    this.nextExpiry = nextExpiry
    for (const entry of revoked) {
      entry.controller.abort()
    }
  }

  /** Repeat sightings cannot change credentials, ancestry or unused-offer expiry. */
  updateSighting(device: DeviceEntry): void {
    this.rows.set(device.deviceId, device)
    const entry = this.authorized.get(device.deviceId)
    if (entry) {
      entry.device = device
    }
  }

  expire(devices: readonly DeviceEntry[], now = Date.now()): void {
    if (now >= this.nextExpiry) {
      this.publish(devices, now)
    }
  }

  row(deviceId: string): DeviceEntry | null {
    return this.rows.get(deviceId) ?? null
  }

  token(token: string): DeviceEntry | null {
    return this.tokens.get(token)?.device ?? null
  }

  principal(binding: AuthenticatedPrincipalBinding): DeviceEntry | null {
    const entry = this.authorized.get(binding.deviceId)
    return entry && isStillAuthenticated(entry.device, binding) ? entry.device : null
  }

  capture(binding: AuthenticatedPrincipalBinding): AuthorizationIncarnation | null {
    return this.principal(binding) ? this.authorized.get(binding.deviceId)!.authority : null
  }
}
