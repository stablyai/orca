import { powerMonitor } from 'electron'

/** Absence of the API is not evidence of battery; desktops answer false anyway. */
export function isAgentAwakeOnBatteryPower(): boolean {
  try {
    return powerMonitor.isOnBatteryPower() === true
  } catch {
    return false
  }
}
