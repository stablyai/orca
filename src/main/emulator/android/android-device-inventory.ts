import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { adbDevicesArgs, parseAdbDevices, type AndroidAdbDevice } from './adb-devices'
import { listAvdsArgs, parseAvdList } from './avd-manager'
import type { EmulatorDevice } from '../backends/emulator-backend'
import { mapWithConcurrency } from '../../../shared/map-with-concurrency'

export const ANDROID_AVD_NAME_LOOKUP_CONCURRENCY = 4

// Android device discovery: turns raw `adb`/`emulator` output into the
// cross-backend EmulatorDevice list and resolves AVD names to running serials.
// Kept separate from the backend so the inventory is testable in isolation and
// the backend file stays focused on lifecycle + input.

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
  const resolved = await mapWithConcurrency(
    running.filter((device) => device.isEmulator),
    ANDROID_AVD_NAME_LOOKUP_CONCURRENCY,
    async (device) => {
      const out = await runner(sdk.adb, ['-s', device.serial, 'emu', 'avd', 'name'])
      return { serial: device.serial, name: firstNonStatusLine(out.stdout) }
    }
  )
  for (const { serial, name } of resolved) {
    if (name) {
      names.set(serial, name)
    }
  }
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

// `adb -s <serial> emu avd name` prints the AVD name then a trailing "OK" line.
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
