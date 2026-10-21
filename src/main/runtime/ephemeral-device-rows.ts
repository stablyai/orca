import type { DeviceEntry } from './device-entry'

// Why: a session-only browser keeps its key in memory; an idle row is an abandoned tab, not a device.
export const EPHEMERAL_DEVICE_IDLE_MS = 12 * 60 * 60 * 1000
export const EPHEMERAL_DEVICE_SWEEP_INTERVAL_MS = 5 * 60 * 1000

/** Rows that survive a host restart: a session-only browser's key did not. */
export function withoutEphemeralRows(devices: readonly DeviceEntry[]): DeviceEntry[] {
  return devices.filter((device) => device.ephemeral !== true)
}

/** Idle is measured from the last connect or disconnect; a row with a live socket never expires. */
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
