import { spawn } from 'node:child_process'
import { EmulatorError } from '../emulator-errors'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { bootCompletedArgs, isBootCompleted } from './adb-devices'
import { bootAvdArgs, listAvdsArgs, parseAvdList } from './avd-manager'
import { findRunningAvdSerial, listRunningAdbDevices } from './android-device-inventory'
import { emulatorProbeError } from '../emulator-probe'

export type AndroidBootOptions = {
  bootTimeoutMs: number
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
}

// Returns the running adb serial for a device/AVD, booting the AVD (detached)
// and polling sys.boot_completed when it is not already running.
export async function bootAndroidDevice(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  deviceOrName: string,
  options: AndroidBootOptions
): Promise<string> {
  const running = await listRunningAdbDevices(runner, sdk)
  if (running.some((device) => device.serial === deviceOrName)) {
    return deviceOrName
  }
  const existing = await findRunningAvdSerial(runner, sdk, deviceOrName, running)
  if (existing) {
    return existing
  }
  // Validate the target is a real AVD before spawning, so a stale/offline serial
  // doesn't launch an invalid `-avd` and burn the full boot timeout.
  const avds = parseAvdList((await runner(sdk.emulator, listAvdsArgs)).stdout)
  if (!avds.includes(deviceOrName)) {
    throw new EmulatorError(
      'emulator_device_not_found',
      `"${deviceOrName}" is not a running device or a known AVD.`
    )
  }
  const known = new Set(running.map((device) => device.serial))
  launchAvd(sdk.emulator, deviceOrName)
  return waitForNewBootedSerial(runner, sdk, deviceOrName, known, options)
}

// Launches the emulator with spawn (NOT the command runner: execFile would kill
// the long-running, verbose emulator at its timeout / stdout maxBuffer). It is
// NOT detached: DETACHED_PROCESS gives the console-subsystem emulator no console,
// so it (and its qemu/netsim children) pop their own visible one. windowsHide
// gives it a hidden console instead; unref lets the app exit without waiting, and
// managed emulators are shut down on quit anyway. -no-window keeps it headless.
function launchAvd(emulatorPath: string, avdName: string): void {
  const child = spawn(emulatorPath, [...bootAvdArgs(avdName), '-no-window'], {
    stdio: 'ignore',
    windowsHide: true
  })
  // An unhandled 'error' (ENOENT/EACCES) on a ChildProcess crashes the main
  // process; swallow + log it so the boot wait surfaces a timeout instead.
  child.on('error', (error) => emulatorProbeError('emulator.launch.fail', error, { avdName }))
  child.unref()
}

async function waitForNewBootedSerial(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  avdName: string,
  known: Set<string>,
  options: AndroidBootOptions
): Promise<string> {
  let waited = 0
  while (waited < options.bootTimeoutMs) {
    const fresh = (await listRunningAdbDevices(runner, sdk)).filter(
      (device) => device.isEmulator && !known.has(device.serial)
    )
    for (const device of fresh) {
      const booted = await runner(sdk.adb, bootCompletedArgs(device.serial))
      if (isBootCompleted(booted.stdout)) {
        return device.serial
      }
    }
    await options.sleep(options.pollIntervalMs)
    waited += options.pollIntervalMs
  }
  throw new EmulatorError(
    'emulator_helper_failed',
    `AVD "${avdName}" did not finish booting in time.`
  )
}
