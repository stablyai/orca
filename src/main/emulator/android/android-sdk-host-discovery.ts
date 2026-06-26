import { homedir, platform } from 'node:os'
import { existsSync } from 'node:fs'
import { discoverAndroidSdk, type AndroidSdkPaths } from './android-sdk-discovery'

// Discovers the Android SDK from the real host environment (process env + fs),
// returning null on any failure so the backend degrades to "unsupported". The
// pure resolver lives in android-sdk-discovery; this wires it to the real host.
export function discoverAndroidSdkFromHost(): AndroidSdkPaths | null {
  try {
    return discoverAndroidSdk({
      env: process.env,
      platform: platform(),
      homedir: homedir(),
      exists: existsSync
    })
  } catch {
    return null
  }
}
