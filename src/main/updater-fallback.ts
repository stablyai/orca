import type { UpdateStatus } from '../shared/update-status-types'
import {
  compareAppVersions,
  isPrereleaseAppVersion,
  isValidAppVersion
} from '../shared/app-version'

export const compareVersions = compareAppVersions
export const isPrereleaseVersion = isPrereleaseAppVersion
export const isValidVersion = isValidAppVersion

export function statusesEqual(left: UpdateStatus, right: UpdateStatus): boolean {
  if (left.source !== right.source) {
    return false
  }
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
        // Changelog objects are recreated per check; dedupe by presence rather than reference.
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
        left.version === right.version &&
        left.retryable === right.retryable &&
        left.retryAction === right.retryAction &&
        left.userInitiated === right.userInitiated &&
        left.activeNudgeId === right.activeNudgeId &&
        // Recovery identity fences async actions, so same-valued recaptures must reach the renderer.
        left.recovery === right.recovery
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

export function isBenignCheckFailure(message: string): boolean {
  const normalizedMessage = message.toLowerCase()

  if (normalizedMessage.includes('net::err_failed')) {
    return true
  }

  // Half-published GitHub releases can fail checks without a client-side fault.
  return (
    isReleaseAssetsPublishingFailure(message) ||
    isGitHubReleaseTransitionFailure(normalizedMessage) ||
    normalizedMessage.includes('no published versions on github')
  )
}
