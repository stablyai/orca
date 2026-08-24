export const E2E_FORCE_DAEMON_INVENTORY_UNAVAILABLE_ENV =
  'ORCA_E2E_FORCE_DAEMON_INVENTORY_UNAVAILABLE'

export const E2E_DISABLE_UNKNOWN_OCCUPANCY_HOLD_ENV = 'ORCA_E2E_DISABLE_UNKNOWN_OCCUPANCY_HOLD'

export function shouldForceDaemonInventoryUnavailable(): boolean {
  return process.env[E2E_FORCE_DAEMON_INVENTORY_UNAVAILABLE_ENV] === '1'
}

export function shouldDisableUnknownOccupancyHold(): boolean {
  return process.env[E2E_DISABLE_UNKNOWN_OCCUPANCY_HOLD_ENV] === '1'
}
