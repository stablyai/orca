import type { DeviceEntry } from './device-entry'

/** The E2EE framing a sign-in used; absent for sightings that are not sign-ins (e.g. disconnects). */
export type DeviceSightingFraming = 'legacy' | 'v2'

/** Record a sighting; a legacy sign-in marks the row for the "older encryption" notice, a v2 one clears it. */
export function withDeviceSighting(
  device: DeviceEntry,
  seenAt: number,
  framing?: DeviceSightingFraming
): DeviceEntry {
  if (framing === 'legacy') {
    return { ...device, lastSeenAt: seenAt, legacyE2EEAuthAt: seenAt }
  }
  if (framing === 'v2' && device.legacyE2EEAuthAt !== undefined) {
    const { legacyE2EEAuthAt: _cleared, ...rest } = device
    return { ...rest, lastSeenAt: seenAt }
  }
  return { ...device, lastSeenAt: seenAt }
}

/** Whether the device's most recent sign-in used the older E2EE framing. */
export function usesLegacyE2EE(device: DeviceEntry): boolean {
  return typeof device.legacyE2EEAuthAt === 'number'
}
