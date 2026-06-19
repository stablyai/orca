import { platform } from 'os'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'

export type EmulatorAvailability = {
  platform: NodeJS.Platform
  available: boolean
  devices: SimulatorDevice[]
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
  message: string
}

export function pickDefaultSimulatorDevice(devices: SimulatorDevice[]): SimulatorDevice | null {
  const available = devices.filter((device) => device.isAvailable !== false)
  const booted = available.filter((device) => device.state === 'Booted')
  const bootedIphone = booted.find((device) => /iPhone/i.test(device.name || ''))
  return (
    bootedIphone ||
    booted[0] ||
    available.find((device) => /iPhone/i.test(device.name || '')) ||
    available[0] ||
    devices[0] ||
    null
  )
}

export async function inspectEmulatorAvailability(
  bridge: EmulatorBridge
): Promise<EmulatorAvailability> {
  const currentPlatform = platform()
  if (currentPlatform !== 'darwin') {
    return {
      platform: currentPlatform,
      available: false,
      devices: [],
      simctl: { ok: false, message: 'iOS Simulator is macOS only.' },
      serveSim: { ok: false, message: 'serve-sim is only used on macOS hosts.' },
      message: 'iOS Simulator requires macOS.'
    }
  }

  let devices: SimulatorDevice[] = []
  let simctl: EmulatorAvailability['simctl'] = { ok: true }
  let serveSim: EmulatorAvailability['serveSim'] = { ok: true }

  try {
    devices = await bridge.listSimulators()
    if (devices.length === 0) {
      simctl = {
        ok: false,
        message: 'No iOS simulators found. Add one in Xcode Settings > Platforms.'
      }
    }
  } catch (error) {
    simctl = {
      ok: false,
      message: error instanceof Error ? error.message : 'xcrun simctl is unavailable.'
    }
  }

  try {
    await bridge.checkServeSimAvailable()
  } catch (error) {
    serveSim = {
      ok: false,
      message: error instanceof Error ? error.message : 'serve-sim is unavailable.'
    }
  }

  const available = simctl.ok && serveSim.ok && devices.length > 0
  const message = available
    ? 'Ready'
    : simctl.message || serveSim.message || 'Mobile Emulator is not available.'
  return { platform: currentPlatform, available, devices, simctl, serveSim, message }
}
