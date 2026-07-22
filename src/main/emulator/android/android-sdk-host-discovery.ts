import { homedir, platform } from 'node:os'
import { existsSync } from 'node:fs'
import {
  discoverAndroidSdk,
  discoverAndroidSdkAtPath,
  type AndroidSdkPaths
} from './android-sdk-discovery'

let configuredSdkPath: string | null = null

export function getConfiguredAndroidSdkPath(): string | null {
  return configuredSdkPath
}

// Lets the user point Orca at an Android SDK in a non-standard location (saved in
// settings). An explicit invalid path stays invalid so the setup UI can explain
// the saved configuration instead of silently running a different SDK.
export function setConfiguredAndroidSdkPath(path: string | null): void {
  const trimmed = path?.trim()
  configuredSdkPath = trimmed ? trimmed : null
}

// Discovers the Android SDK from the real host environment (process env + fs),
// returning null on any failure so the backend degrades to "unsupported". The
// pure resolver lives in android-sdk-discovery; this wires it to the real host.
export function discoverAndroidSdkFromHost(): AndroidSdkPaths | null {
  try {
    const currentPlatform = platform()
    if (configuredSdkPath) {
      return discoverAndroidSdkAtPath(configuredSdkPath, currentPlatform, existsSync)
    }
    return discoverAndroidSdk({
      env: process.env,
      platform: currentPlatform,
      homedir: homedir(),
      exists: existsSync
    })
  } catch {
    return null
  }
}
