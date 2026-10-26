import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { adbDevicesArgs, parseAdbDevices, type AndroidAdbDevice } from './adb-devices'
import { listAvdsArgs, parseAvdList } from './avd-manager'
import type { EmulatorDevice } from '../backends/emulator-backend'

export async function listRunningAdbDevices(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths
): Promise<AndroidAdbDevice[]> {
  const result = await runner(sdk.adb, adbDevicesArgs)
  return parseAdbDevices(result.stdout).filter((device) => device.state === 'device')
}

export async function resolveRunningAvdNames(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  running: AndroidAdbDevice[]
): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  await Promise.all(
    running
      .filter((device) => device.isEmulator)
      .map(async (device) => {
        const out = await runner(sdk.adb, ['-s', device.serial, 'emu', 'avd', 'name'])
        const name = firstNonStatusLine(out.stdout)
        if (name) {
          names.set(device.serial, name)
        }
      })
  )
  return names
}

export async function findRunningAvdSerial(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  avdName: string,
  running: AndroidAdbDevice[]
): Promise<string | null> {
  const names = await resolveRunningAvdNames(runner, sdk, running)
  for (const [serial, name] of names) {
    if (name === avdName) {
      return serial
    }
  }
  return null
}

export async function listAndroidDevices(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths
): Promise<EmulatorDevice[]> {
  const [running, avdsResult] = await Promise.all([
    listRunningAdbDevices(runner, sdk),
    runner(sdk.emulator, listAvdsArgs)
  ])
  const avds = parseAvdList(avdsResult.stdout)
  const runningAvdBySerial = await resolveRunningAvdNames(runner, sdk, running)
  return mergeAndroidDevices(running, avds, runningAvdBySerial)
}

// adb appends an OK status after the AVD name.
function firstNonStatusLine(stdout: string): string | null {
  for (const raw of stdout.split('\n')) {
    const line = raw.trim()
    if (line !== '' && line !== 'OK') {
      return line
    }
  }
  return null
}

export function mergeAndroidDevices(
  running: AndroidAdbDevice[],
  avds: string[],
  runningAvdBySerial: Map<string, string>
): EmulatorDevice[] {
  const devices: EmulatorDevice[] = []
  const bootedAvdNames = new Set(runningAvdBySerial.values())

  for (const device of running) {
    const avdName = runningAvdBySerial.get(device.serial)
    devices.push({
      backend: 'android',
      id: device.serial,
      name: avdName ?? device.model ?? device.serial,
      state: 'booted',
      detail: device.isEmulator ? 'emulator' : 'device',
      isAvailable: true
    })
  }

  for (const avd of avds) {
    if (bootedAvdNames.has(avd)) {
      continue
    }
    devices.push({
      backend: 'android',
      id: avd,
      name: avd,
      state: 'shutdown',
      detail: 'avd',
      isAvailable: true
    })
  }

  return devices
}
