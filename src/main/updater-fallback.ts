import type { UpdateStatus } from '../shared/types'
import {
  compareAppVersions,
  isPrereleaseAppVersion,
  isValidAppVersion
} from '../shared/app-version'

export const compareVersions = compareAppVersions
export const isPrereleaseVersion = isPrereleaseAppVersion
export const isValidVersion = isValidAppVersion

export function statusesEqual(left: UpdateStatus, right: UpdateStatus): boolean {
  switch (left.state) {
    case 'idle':
      return right.state === 'idle'
    case 'checking':
      return right.state === 'checking' && left.userInitiated === right.userInitiated
    case 'not-available':
      return right.state === 'not-available' && left.userInitiated === right.userInitiated
    case 'available':
      return (
        right.state === 'available' &&
        left.version === right.version &&
        left.activeNudgeId === right.activeNudgeId &&
        left.releaseUrl === right.releaseUrl &&
        // Why: fetchChangelog creates a fresh object each time, so reference
        // equality is always false. Compare by presence — since update-available
        // fires at most once per check cycle, this is sufficient.
        Boolean(left.changelog) === Boolean(right.changelog)
      )
    case 'downloading':
      return (
        right.state === 'downloading' &&
        left.version === right.version &&
        left.activeNudgeId === right.activeNudgeId &&
        left.percent === right.percent
      )
    case 'downloaded':
      return (
        right.state === 'downloaded' &&
        left.version === right.version &&
        left.activeNudgeId === right.activeNudgeId &&
        left.releaseUrl === right.releaseUrl
      )
    case 'error':
      return (
        right.state === 'error' &&
        left.message === right.message &&
        left.userInitiated === right.userInitiated &&
        left.activeNudgeId === right.activeNudgeId
      )
  }
}

export function isGitHubReleaseTransitionFailure(normalizedMessage: string): boolean {
  return (
    normalizedMessage.includes('unable to find latest version on github') ||
    normalizedMessage.includes('cannot find channel') ||
    normalizedMessage.includes('latest.yml') ||
    normalizedMessage.includes('latest-mac.yml') ||
    normalizedMessage.includes('no published versions on github')
  )
}

export function isMissingUpdateManifestFailure(message: string): boolean {
  const normalizedMessage = message.toLowerCase()
  return (
    normalizedMessage.includes('404') &&
    (normalizedMessage.includes('cannot find channel') ||
      normalizedMessage.includes('latest.yml') ||
      normalizedMessage.includes('latest-mac.yml') ||
      normalizedMessage.includes('latest-linux.yml'))
  )
}

export function isReleaseAssetsPublishingFailure(message: string): boolean {
  return message.toLowerCase().includes('latest release assets are still publishing')
}

/** Identifies update-check failures that are transient or infrastructure-related
 *  (e.g. network blips, GitHub release transitions) and should NOT be surfaced
 *  to the user as errors. */
export function isBenignCheckFailure(message: string): boolean {
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('net::err_failed')) {
    return true
  }

  // GitHub releases can briefly be in a half-published state while the
  // release workflow is creating a draft and uploading update metadata.
  // During that window electron-updater may fail the check even though
  // nothing is wrong on the client side.
  return (
    isReleaseAssetsPublishingFailure(message) ||
    isGitHubReleaseTransitionFailure(normalizedMessage) ||
    normalizedMessage.includes('no published versions on github')
  )
}
