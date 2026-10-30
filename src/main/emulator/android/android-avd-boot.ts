import { spawn } from 'node:child_process'
import { EmulatorError } from '../emulator-errors'
import { emulatorFailureText } from '../../../shared/emulator-failure-copy'
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
  // Reject stale serials before launching an invalid AVD and waiting out the boot timeout.
  const avds = parseAvdList((await runner(sdk.emulator, listAvdsArgs)).stdout)
  if (!avds.includes(deviceOrName)) {
    throw new EmulatorError(
      'emulator_device_not_found',
      emulatorFailureText('unknownDeviceOrAvd', { device: deviceOrName })
    )
  }
  const known = new Set(running.map((device) => device.serial))
  launchAvd(sdk.emulator, deviceOrName)
  return waitForNewBootedSerial(runner, sdk, deviceOrName, known, options)
}

// Use an unrefed, hidden spawn: detached Windows emulators open consoles; execFile bounds long-running output.
function launchAvd(emulatorPath: string, avdName: string): void {
  const child = spawn(emulatorPath, [...bootAvdArgs(avdName), '-no-window'], {
    stdio: 'ignore',
    windowsHide: true
  })
  // Handle spawn errors here so the boot poll reports failure instead of crashing main.
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
    emulatorFailureText('avdBootTimeout', { avdName })
  )
}
