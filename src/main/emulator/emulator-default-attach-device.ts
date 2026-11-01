import type { EmulatorBridge } from './emulator-bridge'
import type { EmulatorDevice } from './backends/emulator-backend'

const isIphone = (device: EmulatorDevice): boolean =>
  device.backend === 'ios' && /iPhone/i.test(device.name)

// A device already running on either platform beats booting a new one.
export async function resolveDefaultAttachDevice(
  bridge: Pick<EmulatorBridge, 'listAllDevices'>
): Promise<string | undefined> {
  const all = await bridge.listAllDevices()
  const available = all.filter((device) => device.isAvailable)
  const booted = available.filter((device) => device.state === 'booted')
  return (booted.find(isIphone) ?? booted[0] ?? available.find(isIphone) ?? available[0] ?? all[0])
    ?.id
}
