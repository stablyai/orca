import { execFile } from 'node:child_process'
import { platform } from 'node:os'
import { EmulatorError } from './emulator-errors'
import { mapSimctlError } from './simctl-simulator-devices'

export type IosSimulatorBiometryType = 'face' | 'touch'
export type IosSimulatorBiometricAction = 'enroll' | 'unenroll' | 'match' | 'nomatch'

// Why: the widely cited `com.apple.BiometricKit_Simulator.*` prefix posts a no-op —
// BiometricKit.framework in the iOS 18.3, 18.6 and 26.2 runtimes only registers the
// `_Sim` spelling, and the enrollment key alone carries no suffix.
const ENROLLMENT_KEY = 'com.apple.BiometricKit.enrollmentChanged'
const BIOMETRY_KEYS: Record<IosSimulatorBiometryType, { match: string; nomatch: string }> = {
  face: {
    match: 'com.apple.BiometricKit_Sim.pearl.match',
    nomatch: 'com.apple.BiometricKit_Sim.pearl.nomatch'
  },
  touch: {
    match: 'com.apple.BiometricKit_Sim.fingerTouch.match',
    nomatch: 'com.apple.BiometricKit_Sim.fingerTouch.nomatch'
  }
}

const NOTIFYUTIL_TIMEOUT_MS = 15_000

function runNotifyutil(udid: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'xcrun',
      ['simctl', 'spawn', udid, 'notifyutil', ...args],
      { timeout: NOTIFYUTIL_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(mapSimctlError(error, stderr))
          return
        }
        resolve(stdout)
      }
    )
  })
}

async function setBiometricEnrollment(udid: string, enrolled: boolean): Promise<void> {
  const value = enrolled ? '1' : '0'
  await runNotifyutil(udid, ['-s', ENROLLMENT_KEY, value])
  await runNotifyutil(udid, ['-p', ENROLLMENT_KEY])
  // Why: notifyutil exits 0 even for names nothing has registered, and only a real
  // key keeps the value it was set to — reading it back is what turns a renamed key
  // into a loud failure instead of another silent no-op.
  const readBack = await runNotifyutil(udid, ['-g', ENROLLMENT_KEY])
  if (readBack.trim().split(/\s+/).pop() !== value) {
    throw new EmulatorError(
      'emulator_error',
      `The simulator did not accept the biometric enrollment change (${ENROLLMENT_KEY}).`
    )
  }
}

// Drives the simulator's Face ID / Touch ID state the way Simulator.app's Features
// menu does. match/nomatch only land while an app is awaiting LAContext and biometry
// is enrolled; neither condition is observable from here, so they are best-effort.
export async function sendIosSimulatorBiometricEvent(
  udid: string,
  action: IosSimulatorBiometricAction,
  type: IosSimulatorBiometryType = 'face'
): Promise<void> {
  if (platform() !== 'darwin') {
    throw new EmulatorError(
      'emulator_not_macos',
      'iOS Simulator requires macOS with Xcode Command Line Tools.'
    )
  }
  if (action === 'enroll' || action === 'unenroll') {
    await setBiometricEnrollment(udid, action === 'enroll')
    return
  }
  await runNotifyutil(udid, ['-p', BIOMETRY_KEYS[type][action]])
}
