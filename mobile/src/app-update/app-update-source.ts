import {
  compareAppVersions,
  isPrereleaseAppVersion,
  isValidAppVersion
} from '../../../src/shared/app-version'

export type AppUpdateCheckResult =
  | { kind: 'available'; version: string; url: string }
  | { kind: 'current' }

/** One install channel. Rejects when the channel could not be asked; never retries itself. */
export type AppUpdateSource = {
  check(installedVersion: string, signal: AbortSignal): Promise<AppUpdateCheckResult>
}

/** True for a plain release version newer than the installed one; prerelease suffixes never qualify. */
export function isNewerReleaseVersion(candidate: string, installed: string): boolean {
  return (
    isValidAppVersion(candidate) &&
    isValidAppVersion(installed) &&
    !isPrereleaseAppVersion(candidate) &&
    compareAppVersions(candidate, installed) > 0
  )
}
