import { powerMonitor } from 'electron'

/** Absence of the API is not evidence of battery; desktops answer false. */
export function isOnBatteryPower(): boolean {
  try {
    return powerMonitor.isOnBatteryPower() === true
  } catch {
    return false
  }
}
