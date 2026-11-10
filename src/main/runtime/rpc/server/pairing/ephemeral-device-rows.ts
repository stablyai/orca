import type { DeviceEntry } from './device-entry'

// Session-only keys live in browser memory; idle rows represent abandoned tabs.
export const EPHEMERAL_DEVICE_IDLE_MS = 12 * 60 * 60 * 1000
export const EPHEMERAL_DEVICE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

export function withoutEphemeralRows(devices: readonly DeviceEntry[]): DeviceEntry[] {
  return devices.filter((device) => device.ephemeral !== true)
}

/** Live sockets never expire; idle time starts at the last connect/disconnect. */
export function planIdleEphemeralPrune(
  devices: readonly DeviceEntry[],
  now: number,
  isLive: (deviceId: string) => boolean
): { nextDevices: DeviceEntry[]; removed: string[] } {
  const removed = devices
    .filter(
      (device) =>
        device.ephemeral === true &&
        now - device.lastSeenAt > EPHEMERAL_DEVICE_IDLE_MS &&
        !isLive(device.deviceId)
    )
    .map((device) => device.deviceId)
  return {
    nextDevices: devices.filter((device) => !removed.includes(device.deviceId)),
    removed
  }
}
