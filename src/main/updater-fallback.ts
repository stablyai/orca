import type { UpdateStatus } from '../shared/types'

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
    isGitHubReleaseTransitionFailure(normalizedMessage) ||
    normalizedMessage.includes('no published versions on github')
  )
}

type ParsedVersion = {
  core: [number, number, number]
  prerelease: string[]
}

function parseVersion(value: string): ParsedVersion | null {
  const normalized = value.trim().replace(/^v/i, '')
  const match = normalized.match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/
  )
  if (!match) {
    return null
  }

  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split('.') ?? []
  }
}

export function isValidVersion(value: string): boolean {
  return parseVersion(value) !== null
}

// Why: a user running a prerelease build (e.g. 1.3.17-rc.1) needs both:
//   (1) the next RC (1.3.17-rc.2), which the default generic feed hides, and
//   (2) the next stable release, which electron-updater's GitHubProvider
//       channel filter hides when the running build is an RC.
// We detect prerelease builds here so the updater can mine GitHub's atom feed
// itself (any channel) and pin the generic provider at the newest tag. Without
// this detection, a prerelease user would be trapped on the RC they installed.
export function isPrereleaseVersion(value: string): boolean {
  const parsed = parseVersion(value)
  return parsed !== null && parsed.prerelease.length > 0
}

function compareIdentifiers(left: string, right: string): number {
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)

  if (leftNumeric && rightNumeric) {
    return Number(left) - Number(right)
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }
  return left.localeCompare(right)
}

/** Returns negative if left < right, 0 if equal, positive if left > right. */
export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  if (!leftVersion || !rightVersion) {
    return 0
  }

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const leftPart = leftVersion.core[index]
    const rightPart = rightVersion.core[index]
    if (leftPart !== rightPart) {
      return leftPart - rightPart
    }
  }

  const leftPrerelease = leftVersion.prerelease
  const rightPrerelease = rightVersion.prerelease
  if (leftPrerelease.length === 0 && rightPrerelease.length === 0) {
    return 0
  }
  if (leftPrerelease.length === 0) {
    return 1
  }
  if (rightPrerelease.length === 0) {
    return -1
  }

  for (let index = 0; index < Math.max(leftPrerelease.length, rightPrerelease.length); index += 1) {
    const leftPart = leftPrerelease[index]
    const rightPart = rightPrerelease[index]
    if (leftPart === undefined) {
      return -1
    }
    if (rightPart === undefined) {
      return 1
    }

    const comparison = compareIdentifiers(leftPart, rightPart)
    if (comparison !== 0) {
      return comparison
    }
  }

  return 0
}
