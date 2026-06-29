import type { EmulatorBridge } from './emulator-bridge'
import { pickDefaultSimulatorDevice } from './emulator-availability'

// Resolves a default device to attach when none is specified: the iOS default
// picker first (booted iPhone etc. on macOS), else the first booted (else first)
// device across host backends, e.g. Android on Windows/Linux.
export async function resolveDefaultAttachDevice(
  bridge: EmulatorBridge
): Promise<string | undefined> {
  let iosDefault: string | undefined
  try {
    iosDefault = pickDefaultSimulatorDevice(await bridge.listSimulators())?.udid
  } catch {
    iosDefault = undefined
  }
  if (iosDefault) {
    return iosDefault
  }
  const all = await bridge.listAllDevices()
  return (all.find((row) => row.state === 'booted') ?? all[0])?.id
}
