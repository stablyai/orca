import { platform } from 'node:os'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { BackendAvailability, EmulatorDevice } from './backends/emulator-backend'
import type { AndroidSetupStatus, IosSetupStatus } from '../../shared/emulator-setup-types'
import { inspectAndroidSetupFromHost, inspectIosSetupFromHost } from './emulator-setup-host-probe'

export type EmulatorAvailability = {
  platform: NodeJS.Platform
  available: boolean
  devices: SimulatorDevice[]
  ios: IosSetupStatus
  simctl: { ok: boolean; message?: string }
  serveSim: { ok: boolean; message?: string }
  android: AndroidSetupStatus & { sdkFound: boolean }
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
  setup: IosSetupStatus
}

async function inspectIosAvailability(
  bridge: EmulatorBridge,
  setup: IosSetupStatus
): Promise<IosAvailability> {
  const devices = setup.devices
  const simctl: IosAvailability['simctl'] =
    setup.state === 'ready' ? { ok: true } : { ok: false, message: setup.message }
  let serveSim: IosAvailability['serveSim'] = { ok: true }

  if (setup.state === 'ready') {
    try {
      await bridge.checkServeSimAvailable()
    } catch (error) {
      serveSim = {
        ok: false,
        message: error instanceof Error ? error.message : 'serve-sim is unavailable.'
      }
    }
  }

  return {
    available: simctl.ok && serveSim.ok && devices.length > 0,
    devices,
    simctl,
    serveSim,
    setup
  }
}

// Android devices are surfaced through the same SimulatorDevice-shaped list the
// settings pane already renders (name + state + a synthetic "Android" runtime).
function toSimulatorRow(device: EmulatorDevice): SimulatorDevice {
  return {
    name: device.name,
    udid: device.id,
    state: device.state === 'booted' ? 'Booted' : 'Shutdown',
    runtime: 'Android',
    isAvailable: device.isAvailable
  }
}

// Aggregates availability across backends so the Mobile Emulator pane works on
// every desktop platform: iOS (macOS only) plus Android (any host with the SDK).
export async function inspectEmulatorAvailability(
  bridge: EmulatorBridge,
  probes: {
    inspectIos?: () => Promise<IosSetupStatus>
    inspectAndroid?: (backend: BackendAvailability) => AndroidSetupStatus
  } = {}
): Promise<EmulatorAvailability> {
  const currentPlatform = platform()
  const backends = bridge.listBackends()
  const iosBackend = backends.find((backend) => backend.kind === 'ios')
  const androidBackend = backends.find((backend) => backend.kind === 'android')
  const iosSupported = Boolean(iosBackend?.isSupportedOnHost())

  const [android, iosSetup] = await Promise.all([
    androidBackend
      ? androidBackend.checkAvailability()
      : Promise.resolve({ available: false, devices: [], message: '' }),
    (probes.inspectIos ?? inspectIosSetupFromHost)()
  ])
  const ios: IosAvailability = iosSupported
    ? await inspectIosAvailability(bridge, iosSetup)
    : {
        available: false,
        devices: [],
        simctl: { ok: false, message: iosSetup.message },
        serveSim: { ok: false },
        setup: iosSetup
      }
  const androidSetup = (probes.inspectAndroid ?? inspectAndroidSetupFromHost)(android)

  const androidReady = androidSetup.state === 'ready'
  const devices = [...ios.devices, ...(androidReady ? android.devices.map(toSimulatorRow) : [])]
  const available = ios.available || androidReady
  // Why: on non-macOS hosts the iOS messages are irrelevant, so surface the
  // Android setup message instead of "requires macOS".
  const message = available
    ? 'Ready'
    : currentPlatform === 'darwin' && iosSupported
      ? ios.simctl.message ||
        ios.serveSim.message ||
        androidSetup.message ||
        'Mobile Emulator is not available.'
      : androidSetup.message || 'Mobile Emulator is not available.'

  return {
    platform: currentPlatform,
    available,
    devices,
    ios: ios.setup,
    simctl: ios.simctl,
    serveSim: ios.serveSim,
    android: {
      ...androidSetup,
      sdkFound: Boolean(androidSetup.sdkPath && androidSetup.state !== 'sdk-invalid')
    },
    message
  }
}
