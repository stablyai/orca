import { platform } from 'node:os'
import type { EmulatorBridge } from './emulator-bridge'
import type { SimulatorDevice } from './simctl-simulator-devices'
import type { BackendAvailability, EmulatorDevice } from './backends/emulator-backend'
import { emulatorErrorCodedMessage } from './emulator-errors'
import { emulatorCodedMessage, type EmulatorCodedMessage } from '../../shared/emulator-failure-copy'

type ToolchainCheck = { ok: boolean } & Partial<EmulatorCodedMessage>

export type EmulatorAvailability = EmulatorCodedMessage & {
  platform: NodeJS.Platform
  available: boolean
  devices: SimulatorDevice[]
  simctl: ToolchainCheck
  serveSim: ToolchainCheck
  android: EmulatorCodedMessage & { sdkFound: boolean; sdkPath?: string }
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
  simctl: ToolchainCheck
  serveSim: ToolchainCheck
}

async function inspectIosAvailability(bridge: EmulatorBridge): Promise<IosAvailability> {
  let devices: SimulatorDevice[] = []
  let simctl: IosAvailability['simctl'] = { ok: true }
  let serveSim: IosAvailability['serveSim'] = { ok: true }

  try {
    devices = await bridge.listSimulators()
    if (devices.length === 0) {
      simctl = { ok: false, ...emulatorCodedMessage('noIosSimulators') }
    }
  } catch (error) {
    simctl = { ok: false, ...emulatorErrorCodedMessage(error, 'simctlUnavailable') }
  }

  try {
    await bridge.checkServeSimAvailable()
  } catch (error) {
    serveSim = { ok: false, ...emulatorErrorCodedMessage(error, 'serveSimUnavailable') }
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
  const summary: EmulatorCodedMessage = available
    ? { message: 'Ready' }
    : ((currentPlatform === 'darwin'
        ? firstCodedMessage([ios.simctl, ios.serveSim, android])
        : firstCodedMessage([android])) ?? emulatorCodedMessage('notAvailable'))

  return {
    platform: currentPlatform,
    available,
    devices,
    simctl: ios.simctl,
    serveSim: ios.serveSim,
    android: {
      sdkFound: Boolean(android.sdkPath),
      sdkPath: android.sdkPath,
      ...codedMessageFields(android),
      message: android.message || ''
    },
    ...summary
  }
}

function codedMessageFields(source: Partial<EmulatorCodedMessage>): Partial<EmulatorCodedMessage> {
  return {
    ...(source.messageCode !== undefined ? { messageCode: source.messageCode } : {}),
    ...(source.messageParams !== undefined ? { messageParams: source.messageParams } : {})
  }
}

function firstCodedMessage(
  sources: readonly Partial<EmulatorCodedMessage>[]
): EmulatorCodedMessage | null {
  const source = sources.find((candidate) => candidate.message)
  return source?.message ? { message: source.message, ...codedMessageFields(source) } : null
}
