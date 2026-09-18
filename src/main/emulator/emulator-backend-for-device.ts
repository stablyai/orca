import { platform } from 'node:os'
import { isAdbNetworkSerial } from './android/adb-network-endpoint'
import type { AndroidEmulatorBackend } from './backends/android-emulator-backend'
import type { IosEmulatorBackend } from './backends/ios-emulator-backend'
import type { EmulatorBackend } from './backends/emulator-backend'

export type EmulatorBackendForDeviceHost = {
  backends: readonly EmulatorBackend[]
  androidBackend: AndroidEmulatorBackend
  iosBackend: IosEmulatorBackend
}

// host:port is Android even when offline/unrecognized — classify it before
// ownsDevice so it never falls through to the iOS/host-platform fallback.
export async function resolveEmulatorBackendForDevice(
  device: string,
  host: EmulatorBackendForDeviceHost
): Promise<EmulatorBackend> {
  if (isAdbNetworkSerial(device)) {
    return host.androidBackend
  }
  for (const backend of host.backends) {
    if (await backend.ownsDevice(device)) {
      return backend
    }
  }
  // Unrecognized devices should surface the host-primary setup error
  // (Android on Windows/Linux, iOS on macOS) rather than iOS-on-Windows.
  return (
    host.backends.find((backend) => backend.isSupportedOnHost()) ??
    (platform() === 'darwin' ? host.iosBackend : host.androidBackend)
  )
}
