import { homedir, platform } from 'node:os'
import { existsSync } from 'node:fs'
import { discoverAndroidSdk, type AndroidSdkPaths } from './android-sdk-discovery'

let configuredSdkPath: string | null = null

// Invalid configured paths fall back to environment and platform defaults.
export function setConfiguredAndroidSdkPath(path: string | null): void {
  const trimmed = path?.trim()
  configuredSdkPath = trimmed ? trimmed : null
}

export function discoverAndroidSdkFromHost(): AndroidSdkPaths | null {
  const env = configuredSdkPath ? { ...process.env, ANDROID_HOME: configuredSdkPath } : process.env
  try {
    return discoverAndroidSdk({ env, platform: platform(), homedir: homedir(), exists: existsSync })
  } catch {
    return null
  }
}
