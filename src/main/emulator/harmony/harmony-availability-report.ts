import type { BackendAvailability, EmulatorDevice } from '../backends/emulator-backend'
import type { HarmonySdkPaths } from './harmony-sdk-discovery'

// Builds the availability report from the resolved toolchain and current
// devices, with setup guidance for the no-sdk and no-device cases.
export async function buildHarmonyAvailability(
  resolveSdk: () => HarmonySdkPaths | null,
  listDevices: () => Promise<EmulatorDevice[]>
): Promise<BackendAvailability> {
  const sdk = resolveSdk()
  if (!sdk) {
    return {
      available: false,
      devices: [],
      message:
        'HarmonyOS toolchain not found. Install DevEco Studio with the HarmonyOS SDK and Emulator.'
    }
  }
  const sdkPath = sdk.sdkRoot
  let devices: EmulatorDevice[] = []
  try {
    devices = await listDevices()
  } catch (error) {
    return {
      available: false,
      devices: [],
      message: error instanceof Error ? error.message : 'hdc is unavailable.',
      sdkPath
    }
  }
  if (devices.length === 0) {
    return {
      available: false,
      devices,
      message: 'No HarmonyOS devices or emulator instances found. Create one in DevEco Studio.',
      sdkPath
    }
  }
  return { available: true, devices, message: 'Ready', sdkPath }
}
