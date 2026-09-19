import { existsSync } from 'node:fs'

const DISABLED_SESSION_BUS_ADDRESS = 'disabled:'

export type SessionBusRepairOverrides = {
  uid?: number
  socketExists?: (path: string) => boolean
}

function userBusSocketPath(uid: number | undefined): string | null {
  if (uid === undefined) {
    return null
  }
  return `/run/user/${uid}/bus`
}

export function repairDisabledSessionBusEnv(
  env: Record<string, string | undefined>,
  overrides?: SessionBusRepairOverrides
): void {
  const busAddress = env.DBUS_SESSION_BUS_ADDRESS
  if (process.platform !== 'linux' || busAddress !== DISABLED_SESSION_BUS_ADDRESS) {
    return
  }
  const socketPath = userBusSocketPath(overrides?.uid ?? process.getuid?.())
  const socketExists = overrides?.socketExists ?? existsSync
  if (!socketPath || !socketExists(socketPath)) {
    return
  }
  // Why: Chromium marks the bus disabled when none is set at launch, and headless
  // serve inherits that marker into every spawned shell, breaking user-bus tools.
  env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${socketPath}`
}
