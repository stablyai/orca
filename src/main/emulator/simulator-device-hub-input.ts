import { execFile } from 'node:child_process'
import { EmulatorError } from './emulator-errors'
import { emulatorFailureText } from '../../shared/emulator-failure-copy'

// Xcode 27's Device Hub sets this in every booted simulator; while it is 1 the guest drops serve-sim's touch and keyboard HID.
const DEVICE_HUB_INPUT_KEY = 'com.apple.coredevice.dtuhidd.active'

// Unknown state (older Xcode, shutdown device) counts as clear so the input command reports its own failure.
function isDeviceHubInputActive(udid: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'xcrun',
      ['simctl', 'spawn', udid, 'notifyutil', '-g', DEVICE_HUB_INPUT_KEY],
      { timeout: 5_000 },
      (error, stdout) => resolve(!error && stdout.trim() === `${DEVICE_HUB_INPUT_KEY} 1`)
    )
  })
}

export async function assertSimulatorInputNotShadowedByDeviceHub(udid: string): Promise<void> {
  if (await isDeviceHubInputActive(udid)) {
    throw new EmulatorError('emulator_input_blocked', emulatorFailureText('deviceHubInputBlocked'))
  }
}
