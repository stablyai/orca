import { app } from 'electron'

/** Unpackaged macOS builds use Chromium's mock keychain unless ORCA_DEV_USE_KEYCHAIN=1. */
export function configureDevKeychain(isDev: boolean): void {
  if (process.platform !== 'darwin' || !isDev || process.env.ORCA_DEV_USE_KEYCHAIN === '1') {
    return
  }
  // Why: fresh dev bundles otherwise block on hidden macOS Keychain prompts.
  // Must run before ready so safeStorage and Chromium's cookie crypto both pick it up.
  app.commandLine.appendSwitch('use-mock-keychain')
}
