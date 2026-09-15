import type { AdbConnectionStatus } from './android/adb-device-connection'
import type { AndroidEmulatorBackend } from './backends/android-emulator-backend'
import type { EmulatorSessionRegistry } from './emulator-session-registry'

// Why: EmulatorBridge's ADB surface lives here so the router file stays
// under max-lines. Connect is still the only `adb connect` initiator.
export async function connectAdbNetworkDevice(
  androidBackend: AndroidEmulatorBackend,
  address: string
): Promise<AdbConnectionStatus> {
  return androidBackend.adbConnection.connect(address)
}

export async function adbNetworkConnectionStatus(
  androidBackend: AndroidEmulatorBackend,
  address: string
): Promise<AdbConnectionStatus> {
  return androidBackend.adbConnection.status(address)
}

export function currentAdbNetworkAddress(androidBackend: AndroidEmulatorBackend): string | null {
  return androidBackend.adbConnection.currentAddress()
}

// Stop this device's scrcpy helper and drop the session before `adb disconnect`
// so nothing keeps pointing at a serial adb no longer recognizes.
export async function disconnectAdbNetworkDevice(
  androidBackend: AndroidEmulatorBackend,
  sessionRegistry: EmulatorSessionRegistry,
  address: string
): Promise<AdbConnectionStatus> {
  const serial = androidBackend.adbConnection.serialFor(address) ?? address
  await androidBackend.stopHelperForDevice(serial, { includeOrphaned: true })
  sessionRegistry.clearSessionAndWorktrees(serial)
  return androidBackend.adbConnection.disconnect(address)
}
