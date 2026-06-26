import { spawn } from 'node:child_process'
import { EmulatorError } from '../emulator-errors'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { bootCompletedArgs, isBootCompleted } from './adb-devices'
import { bootAvdArgs } from './avd-manager'
import { findRunningAvdSerial, listRunningAdbDevices } from './android-device-inventory'

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
