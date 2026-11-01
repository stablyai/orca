import { runProcess } from '@orca/process-host'
import { EmulatorError } from './emulator-errors'
import { emulatorFailureText } from '../../shared/emulator-failure-copy'

// Xcode 27's Device Hub sets this in every booted simulator; while it is 1 the guest drops serve-sim's touch and keyboard HID.
const DEVICE_HUB_INPUT_KEY = 'com.apple.coredevice.dtuhidd.active'

// Unknown state (older Xcode, shutdown device) counts as clear so the input command reports its own failure.
async function isDeviceHubInputActive(udid: string): Promise<boolean> {
  try {
    const result = await runProcess({
      program: 'xcrun',
      args: ['simctl', 'spawn', udid, 'notifyutil', '-g', DEVICE_HUB_INPUT_KEY],
      timeoutMs: 5_000
    })
    return result.code === 0 && result.stdout.trim() === `${DEVICE_HUB_INPUT_KEY} 1`
  } catch {
    return false
  }
}

export async function assertSimulatorInputNotShadowedByDeviceHub(udid: string): Promise<void> {
  if (await isDeviceHubInputActive(udid)) {
    throw new EmulatorError('emulator_input_blocked', emulatorFailureText('deviceHubInputBlocked'))
  }
}
