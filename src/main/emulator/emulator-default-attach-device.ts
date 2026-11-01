import type { EmulatorBridge } from './emulator-bridge'
import type { EmulatorDevice } from './backends/emulator-backend'

const isIphone = (device: EmulatorDevice): boolean =>
  device.backend === 'ios' && /iPhone/i.test(device.name)

// The workspace's still-booted device, then the configured default, then any running device.
export async function resolveDefaultAttachDevice(
  bridge: Pick<EmulatorBridge, 'listAllDevices'>,
  { current, configured }: { current?: string; configured?: string } = {}
): Promise<string | undefined> {
  if (!current && configured) {
    return configured
  }
  const all = await bridge.listAllDevices()
  const available = all.filter((device) => device.isAvailable)
  const booted = available.filter((device) => device.state === 'booted')
  if (current && booted.some((device) => device.id === current)) {
    return current
  }
  if (configured) {
    return configured
  }
  return (booted.find(isIphone) ?? booted[0] ?? available.find(isIphone) ?? available[0] ?? all[0])
    ?.id
}
