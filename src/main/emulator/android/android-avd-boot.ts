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
  launchAvdDetached(sdk.emulator, deviceOrName)
  return waitForNewBootedSerial(runner, sdk, deviceOrName, known, options)
}

// Launches the emulator as a detached, unref'd process. It must outlive this
// call and must NOT go through the command runner: execFile would kill the
// long-running emulator at its timeout (and risks the stdout maxBuffer).
// -no-window runs it headless (the scrcpy pane is the view, parity with iOS
// hiding Simulator.app); windowsHide + ignored stdio prevent a stray console.
function launchAvdDetached(emulatorPath: string, avdName: string): void {
  const child = spawn(emulatorPath, [...bootAvdArgs(avdName), '-no-window'], {
    detached: true,
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
