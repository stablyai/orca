import { platform } from 'node:os'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { BackendAvailability, EmulatorDevice } from './backends/emulator-backend'

export type EmulatorAvailability = {
  platform: NodeJS.Platform
  available: boolean
  devices: SimulatorDevice[]
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
  android: { sdkFound: boolean; sdkPath?: string; message: string }
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

type IosAvailability = {
  available: boolean
  devices: SimulatorDevice[]
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
}

async function inspectIosAvailability(bridge: EmulatorBridge): Promise<IosAvailability> {
  let devices: SimulatorDevice[] = []
  let simctl: IosAvailability['simctl'] = { ok: true }
  let serveSim: IosAvailability['serveSim'] = { ok: true }

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

  return { available: simctl.ok && serveSim.ok && devices.length > 0, devices, simctl, serveSim }
}

function toSimulatorRow(device: EmulatorDevice): SimulatorDevice {
  return {
    name: device.name,
    udid: device.id,
    state: device.state === 'booted' ? 'Booted' : 'Shutdown',
    runtime: 'Android',
    isAvailable: device.isAvailable
  }
}

export async function inspectEmulatorAvailability(
  bridge: EmulatorBridge
): Promise<EmulatorAvailability> {
  const currentPlatform = platform()
  const backends = bridge.listBackends()
  const iosBackend = backends.find((backend) => backend.kind === 'ios')
  const androidBackend = backends.find((backend) => backend.kind === 'android')

  const ios: IosAvailability = iosBackend?.isSupportedOnHost()
    ? await inspectIosAvailability(bridge)
    : { available: false, devices: [], simctl: { ok: false }, serveSim: { ok: false } }

  const android: BackendAvailability = androidBackend
    ? await androidBackend.checkAvailability()
    : { available: false, devices: [], message: '' }

  const devices = [...ios.devices, ...android.devices.map(toSimulatorRow)]
  const available = ios.available || android.available
  // Outside macOS, report Android setup rather than an irrelevant iOS host error.
  const message = available
    ? 'Ready'
    : currentPlatform === 'darwin'
      ? ios.simctl.message ||
        ios.serveSim.message ||
        android.message ||
        'Mobile Emulator is not available.'
      : android.message || 'Mobile Emulator is not available.'

  return {
    platform: currentPlatform,
    available,
    devices,
    simctl: ios.simctl,
    serveSim: ios.serveSim,
    android: {
      sdkFound: Boolean(android.sdkPath),
      sdkPath: android.sdkPath,
      message: android.message || ''
    },
    message
  }
}
