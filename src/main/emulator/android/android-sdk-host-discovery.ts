import { homedir, platform } from 'node:os'
import { existsSync } from 'node:fs'
import { discoverAndroidSdk, type AndroidSdkPaths } from './android-sdk-discovery'

let configuredSdkPath: string | null = null

// Lets the user point Orca at an Android SDK in a non-standard location (saved in
// settings). Applied as the highest-priority candidate; an invalid path falls
// back to ANDROID_HOME / ANDROID_SDK_ROOT / the default install location.
export function setConfiguredAndroidSdkPath(path: string | null): void {
  const trimmed = path?.trim()
  configuredSdkPath = trimmed ? trimmed : null
}

// Discovers the Android SDK from the real host environment (process env + fs),
// returning null on any failure so the backend degrades to "unsupported". The
// pure resolver lives in android-sdk-discovery; this wires it to the real host.
export function discoverAndroidSdkFromHost(): AndroidSdkPaths | null {
  const env = configuredSdkPath ? { ...process.env, ANDROID_HOME: configuredSdkPath } : process.env
  try {
    return discoverAndroidSdk({ env, platform: platform(), homedir: homedir(), exists: existsSync })
  } catch {
    return null
  }
}
