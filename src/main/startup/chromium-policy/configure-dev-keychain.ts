import { app } from 'electron'

let devMockKeychain = false
let devKeychainModeSwitchable = false

/** Unpackaged macOS builds use Chromium's mock keychain unless ORCA_DEV_USE_KEYCHAIN=1. */
export function configureDevKeychain(isDev: boolean): void {
  if (process.platform !== 'darwin' || !isDev) {
    return
  }
  devKeychainModeSwitchable = true
  if (process.env.ORCA_DEV_USE_KEYCHAIN === '1') {
    return
  }
  // Why: fresh dev bundles otherwise block on hidden macOS Keychain prompts.
  // Must run before ready so safeStorage and Chromium's cookie crypto both pick it up.
  app.commandLine.appendSwitch('use-mock-keychain')
  devMockKeychain = true
}

/** True only when configureDevKeychain chose the mock keychain for this run. */
export function usesDevMockKeychain(): boolean {
  return devMockKeychain
}

/** True on macOS dev builds, where data from both keychain modes can sit in one profile. */
export function canSwitchDevKeychainMode(): boolean {
  return devKeychainModeSwitchable
}
