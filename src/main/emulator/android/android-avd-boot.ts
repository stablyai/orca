import { spawn } from 'node:child_process'
import { createOutputSink } from '@orca/process-host/bounded-output-sink'
import { EmulatorError } from '../emulator-errors'
import { emulatorFailureText } from '../../../shared/emulator-failure-copy'
import type { AndroidCommandRunner } from './android-command-runner'
import type { AndroidSdkPaths } from './android-sdk-discovery'
import { bootCompletedArgs, isBootCompleted } from './adb-devices'
import { bootAvdArgs } from './avd-manager'
import {
  findRunningAvdSerial,
  listAvdNames,
  listConfirmedAdbDevices,
  listRunningAdbDevices
} from './android-device-inventory'
import { emulatorProbeError } from '../emulator-probe'

export type AndroidBootOptions = {
  bootTimeoutMs: number
  pollIntervalMs: number
  sleep: (ms: number) => Promise<void>
}

type AvdLaunch = {
  // Non-null once the launch failed (spawn error, non-zero exit or signal): its last output lines.
  failureDetail: () => string | null
  closeOutput: () => void
}

const OUTPUT_TAIL_BYTES = 4096
const EXIT_DETAIL_LINES = 3
// adb lists a new emulator ~1.5 s after launch; an empty listing proves no other instance of the
// AVD is booting only after this many polls (~4 s).
const ADB_REGISTRATION_POLLS = 2

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
  const avds = await listAvdNames(runner, sdk)
  if (!sdk.emulator || !avds.includes(deviceOrName)) {
    throw new EmulatorError(
      'emulator_device_not_found',
      emulatorFailureText('unknownDeviceOrAvd', { device: deviceOrName })
    )
  }
  const known = new Set(running.map((device) => device.serial))
  const launch = launchAvd(sdk.emulator, deviceOrName)
  try {
    return await waitForNewBootedSerial(runner, sdk, deviceOrName, known, launch, options)
  } finally {
    launch.closeOutput()
  }
}

// Unrefed hidden spawn: detached Windows emulators open consoles. Output is piped only for the
// boot wait; the emulator ignores SIGPIPE, so it keeps running after the pipes close.
function launchAvd(emulatorPath: string, avdName: string): AvdLaunch {
  const child = spawn(emulatorPath, [...bootAvdArgs(avdName), '-no-window'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  const output = createOutputSink(OUTPUT_TAIL_BYTES, 'tail')
  let endReason: string | null = null
  child.stdout?.on('data', output.write)
  child.stderr?.on('data', output.write)
  // Handle spawn errors here so the boot poll reports failure instead of crashing main.
  child.on('error', (error) => {
    emulatorProbeError('emulator.launch.fail', error, { avdName })
    endReason ??= error.message
  })
  // A clean exit may be a launcher handing off to qemu, so only a failed exit ends the wait early.
  child.on('exit', (code, signal) => {
    if (signal || code !== 0) {
      endReason ??= signal ? `signal ${signal}` : `exit code ${code}`
    }
  })
  child.unref()
  return {
    failureDetail: () =>
      endReason === null ? null : emulatorExitDetail(output.text()) || endReason,
    closeOutput: () => {
      child.stdout?.destroy()
      child.stderr?.destroy()
    }
  }
}

async function waitForNewBootedSerial(
  runner: AndroidCommandRunner,
  sdk: AndroidSdkPaths,
  avdName: string,
  known: Set<string>,
  launch: AvdLaunch,
  options: AndroidBootOptions
): Promise<string> {
  // Wall clock, so adb call time counts toward the timeout the CLI's attach timeout outlasts.
  const deadline = performance.now() + options.bootTimeoutMs
  for (let poll = 0; performance.now() < deadline; poll++) {
    // Read before polling so an instance that appeared as our launch ended is still seen.
    const failureDetail = launch.failureDetail()
    const devices = await listConfirmedAdbDevices(runner, sdk)
    const fresh = (devices ?? []).filter((device) => device.isEmulator && !known.has(device.serial))
    const serial = await findRunningAvdSerial(runner, sdk, avdName, fresh)
    if (serial) {
      const booted = await runner(sdk.adb, bootCompletedArgs(serial))
      if (isBootCompleted(booted.stdout)) {
        return serial
      }
    } else if (failureDetail !== null && devices !== null && poll >= ADB_REGISTRATION_POLLS) {
      // Our launch exits on the AVD lock when another instance is booting, so fail only when a
      // successful adb listing shows none.
      throw new EmulatorError(
        'emulator_helper_failed',
        emulatorFailureText('avdExitedBeforeBoot', { avdName, detail: failureDetail })
      )
    }
    await options.sleep(options.pollIntervalMs)
  }
  throw new EmulatorError(
    'emulator_helper_failed',
    emulatorFailureText('avdBootTimeout', { avdName })
  )
}

// The emulator prints its reason last, e.g. a missing system image then "FATAL | Cannot find AVD system path".
function emulatorExitDetail(output: string): string {
  return output
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-EXIT_DETAIL_LINES)
    .join('\n')
}
