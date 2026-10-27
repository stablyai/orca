import type { EmulatorBridge } from './emulator-bridge'
import { pickDefaultSimulatorDevice } from './emulator-availability'

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
