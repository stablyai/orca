import { isDeepStrictEqual } from 'node:util'
import type { DeviceEntry } from './device-entry'
import { normalizeLoadedDeviceRow } from './device-registry-row-validation'

function security(device: DeviceEntry) {
  const {
    name: _name,
    lastSeenAt,
    lastSourceClass: _source,
    legacyE2EEAuthAt: _framing,
    ...rest
  } = normalizeLoadedDeviceRow(device)!
  return { ...rest, paired: lastSeenAt > 0 }
}

export function sameDeviceSecurity(left: DeviceEntry, right: DeviceEntry): boolean {
  return left === right || isDeepStrictEqual(security(left), security(right))
}

export function isDeviceFirstSighting(before: DeviceEntry, after: DeviceEntry): boolean {
  const {
    offerExpiresAt: _beforeExpiry,
    ticketFirstSeenAt: _beforeFirst,
    paired: _beforePaired,
    ...origin
  } = security(before)
  const {
    offerExpiresAt: _afterExpiry,
    ticketFirstSeenAt: _afterFirst,
    paired: _afterPaired,
    ...nextOrigin
  } = security(after)
  const first = after.ticketFirstSeenAt ?? after.lastSeenAt
  return (
    before.lastSeenAt === 0 &&
    after.lastSeenAt > 0 &&
    after.offerExpiresAt === undefined &&
    isDeepStrictEqual(origin, nextOrigin) &&
    first >= before.pairedAt &&
    (before.offerExpiresAt === undefined || first < before.offerExpiresAt) &&
    (before.ticketFirstSeenAt === undefined || first === before.ticketFirstSeenAt)
  )
}

export function continuesDeviceOffer(before: DeviceEntry, after: DeviceEntry): boolean {
  return (
    (before.lastSeenAt > 0 === after.lastSeenAt > 0 &&
      before.pairedAt === after.pairedAt &&
      before.offerExpiresAt === after.offerExpiresAt &&
      before.ticketFirstSeenAt === after.ticketFirstSeenAt) ||
    isDeviceFirstSighting(before, after)
  )
}

function sightings(
  before: DeviceEntry,
  local: DeviceEntry,
  disk: DeviceEntry,
  chosen: DeviceEntry
): DeviceEntry {
  const latest = local.lastSeenAt >= disk.lastSeenAt ? local : disk
  const first = [local.ticketFirstSeenAt, disk.ticketFirstSeenAt].filter((at) => at !== undefined)
  return {
    ...chosen,
    name: local.name !== before.name && disk.name === before.name ? local.name : disk.name,
    lastSeenAt: Math.max(local.lastSeenAt, disk.lastSeenAt),
    lastSourceClass: latest.lastSourceClass,
    legacyE2EEAuthAt: latest.legacyE2EEAuthAt,
    ...(first.length ? { ticketFirstSeenAt: Math.min(...first) } : {})
  }
}

/** A sighting may pair its original offer, but cannot carry old authority over a disk reset. */
export function reconcileDeviceRegistry(
  baseline: readonly DeviceEntry[],
  local: readonly DeviceEntry[],
  disk: readonly DeviceEntry[],
  removed: ReadonlySet<string>,
  options: { observing?: boolean; guards?: readonly string[]; created?: ReadonlySet<string> } = {}
): { devices: DeviceEntry[]; conflict: boolean } {
  const { observing = false, guards = [], created } = options
  const previous = new Map(baseline.map((device) => [device.deviceId, device]))
  const pending = new Map(local.map((device) => [device.deviceId, device]))
  const current = new Map(disk.map((device) => [device.deviceId, device]))
  const checked = new Map<string, boolean>()
  const unchangedAncestor = (id: string): boolean => {
    if (checked.has(id)) {
      return checked.get(id)!
    }
    checked.set(id, false)
    const before = previous.get(id)
    const after = current.get(id)
    const valid =
      before !== undefined &&
      after !== undefined &&
      (sameDeviceSecurity(before, after) || isDeviceFirstSighting(before, after)) &&
      [before.parentDeviceId, before.forkedFrom].every(
        (parent) => parent === undefined || unchangedAncestor(parent)
      )
    checked.set(id, valid)
    return valid
  }
  const dependencies = (row: DeviceEntry) =>
    [row.parentDeviceId, row.forkedFrom].every((id) => id === undefined || unchangedAncestor(id))
  const devices: DeviceEntry[] = []
  let conflict = guards.some((id) => !unchangedAncestor(id))
  for (const id of new Set([...pending.keys(), ...current.keys()])) {
    if (removed.has(id)) {
      continue
    }
    const before = previous.get(id)
    const next = pending.get(id)
    const winner = current.get(id)
    if (!winner) {
      if (!before && next && !observing && (created === undefined || created.has(id))) {
        if (dependencies(next)) {
          devices.push(next)
        } else {
          conflict = true
        }
      } else if (before && next && !sameDeviceSecurity(before, next)) {
        conflict = true
      }
      continue
    }
    if (!before) {
      devices.push(winner)
      if (next && !sameDeviceSecurity(next, winner)) {
        conflict = true
      }
      continue
    }
    if (!next) {
      if (observing || !sameDeviceSecurity(before, winner)) {
        devices.push(winner)
        conflict ||= !observing
      }
      continue
    }
    // No local change to preserve: disk is authoritative, including its security/lifecycle fields.
    if (next === before) {
      devices.push(winner)
      continue
    }
    const localFirst = isDeviceFirstSighting(before, next)
    const diskFirst = isDeviceFirstSighting(before, winner)
    const unchanged = sameDeviceSecurity(before, winner)
    if (!dependencies(next)) {
      devices.push(winner)
      conflict ||= !observing && !sameDeviceSecurity(before, next)
    } else if (localFirst && (unchanged || diskFirst)) {
      devices.push(sightings(before, next, winner, next))
    } else if (unchanged && !observing) {
      devices.push(sightings(before, next, winner, next))
    } else if (sameDeviceSecurity(next, winner)) {
      devices.push(sightings(before, next, winner, winner))
    } else {
      devices.push(winner)
      conflict ||= !observing && !sameDeviceSecurity(before, next)
    }
  }
  return { devices, conflict }
}
