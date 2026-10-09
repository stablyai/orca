import { homedir, platform } from 'node:os'
import { existsSync } from 'node:fs'
import { discoverHarmonySdk, type HarmonySdkPaths } from './harmony-sdk-discovery'

let configuredSdkPath: string | null = null

// Lets the user point Orca at a HarmonyOS toolchain in a non-standard location
// (saved in settings). Applied as the highest-priority candidate; an invalid
// path falls back to env vars / the default install locations.
export function setConfiguredHarmonySdkPath(path: string | null): void {
  const trimmed = path?.trim()
  configuredSdkPath = trimmed ? trimmed : null
}

// Discovers the HarmonyOS toolchain from the real host environment, returning
// null on any failure so the backend degrades to "unsupported".
export function discoverHarmonySdkFromHost(): HarmonySdkPaths | null {
  const env = configuredSdkPath ? { ...process.env, HOS_SDK_HOME: configuredSdkPath } : process.env
  try {
    return discoverHarmonySdk({ env, platform: platform(), homedir: homedir(), exists: existsSync })
  } catch {
    return null
  }
}
