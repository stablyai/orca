import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export type MacOSHelperSystemCompatibility = {
  compatible: boolean
  currentVersion: string
  minimumVersion: string
}

const compatibilityByHelperAppPath = new Map<string, MacOSHelperSystemCompatibility>()

export function getMacOSComputerUseHelperCompatibility(
  helperAppPath: string
): MacOSHelperSystemCompatibility | null {
  const cached = compatibilityByHelperAppPath.get(helperAppPath)
  if (cached) {
    return cached
  }
  const currentVersion = readCurrentMacOSVersion()
  const minimumVersion = readHelperMinimumMacOSVersion(helperAppPath)
  if (!currentVersion || !minimumVersion) {
    return null
  }
  const compatibility = {
    compatible: compareVersions(currentVersion, minimumVersion) >= 0,
    currentVersion,
    minimumVersion
  }
  compatibilityByHelperAppPath.set(helperAppPath, compatibility)
  return compatibility
}

export function clearMacOSComputerUseHelperCompatibilityCache(): void {
  compatibilityByHelperAppPath.clear()
}

export function formatMacOSComputerUseHelperUnavailableReason(
  compatibility: MacOSHelperSystemCompatibility
): string {
  return `Orca Computer Use requires macOS ${compatibility.minimumVersion} or newer (this Mac is running macOS ${compatibility.currentVersion})`
}

export function compareVersions(left: string, right: string): number {
  const leftParts = parseVersion(left)
  const rightParts = parseVersion(right)
  if (!leftParts || !rightParts) {
    return Number.NaN
  }
  const count = Math.max(leftParts.length, rightParts.length)
  for (let index = 0; index < count; index++) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (difference !== 0) {
      return difference
    }
  }
  return 0
}

function readCurrentMacOSVersion(): string | null {
  const electronVersion = (
    process as NodeJS.Process & { getSystemVersion?: () => string }
  ).getSystemVersion?.()
  if (parseVersion(electronVersion)) {
    return electronVersion ?? null
  }
  try {
    const version = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
    return parseVersion(version) ? version : null
  } catch {
    return null
  }
}

function readHelperMinimumMacOSVersion(helperAppPath: string): string | null {
  try {
    const version = execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', 'Print :LSMinimumSystemVersion', join(helperAppPath, 'Contents', 'Info.plist')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    return parseVersion(version) ? version : null
  } catch {
    return null
  }
}

function parseVersion(version: string | null | undefined): number[] | null {
  if (!version || !/^\d+(?:\.\d+)*$/.test(version)) {
    return null
  }
  return version.split('.').map(Number)
}
