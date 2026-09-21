import { describe, expect, it } from 'vitest'
import type { UpdateStatus } from '../shared/update-status-types'
import {
  compareVersions,
  isBenignCheckFailure,
  isMissingUpdateManifestFailure,
  isReleaseAssetsPublishingFailure,
  isPrereleaseVersion,
  statusesEqual
} from './updater-fallback'

describe('compareVersions', () => {
  it('compares prerelease and build semver strings correctly', () => {
    expect(compareVersions('1.0.70-rc.1', '1.0.69')).toBeGreaterThan(0)
    expect(compareVersions('1.0.70', '1.0.70-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.70+build.5', '1.0.70')).toBe(0)
    expect(compareVersions('v1.0.70-beta.2', '1.0.70-beta.1')).toBeGreaterThan(0)
  })
})

describe('isPrereleaseVersion', () => {
  it('recognises RC, beta, and alpha variants', () => {
    expect(isPrereleaseVersion('1.3.17-rc.1')).toBe(true)
    expect(isPrereleaseVersion('v1.3.17-rc.2')).toBe(true)
    expect(isPrereleaseVersion('1.0.0-beta.5')).toBe(true)
    expect(isPrereleaseVersion('2.1.0-alpha')).toBe(true)
  })

  it('returns false for stable releases and unparseable values', () => {
    expect(isPrereleaseVersion('1.3.17')).toBe(false)
    expect(isPrereleaseVersion('v1.3.17')).toBe(false)
    expect(isPrereleaseVersion('1.3.17+build.5')).toBe(false)
    expect(isPrereleaseVersion('not-a-version')).toBe(false)
  })
})

describe('isMissingUpdateManifestFailure', () => {
  it('matches platform manifest 404s but not generic network failures', () => {
    expect(
      isMissingUpdateManifestFailure(
        'Cannot find channel "latest-mac.yml" update info: HttpError: 404'
      )
    ).toBe(true)
    expect(isMissingUpdateManifestFailure('net::ERR_FAILED')).toBe(false)
    expect(isMissingUpdateManifestFailure('Unable to find latest version on GitHub')).toBe(false)
  })
})

describe('isBenignCheckFailure', () => {
  it('treats in-progress release asset publication as retryable', () => {
    expect(isBenignCheckFailure('Latest release assets are still publishing')).toBe(true)
  })
})

describe('statusesEqual', () => {
  const recovery = {
    kind: 'linux-package-install',
    packageType: 'deb',
    reason: 'authentication-agent-unavailable',
    version: '1.0.61'
  } as const
  const withRecovery: UpdateStatus = { state: 'error', message: 'install failed', recovery }
  const withoutRecovery: UpdateStatus = { state: 'error', message: 'install failed' }

  it('does not dedupe a recovery-carrying error against the same message without recovery', () => {
    // Why: deduping here would leave the card's copy/show actions enabled with no usable package.
    expect(statusesEqual(withRecovery, withoutRecovery)).toBe(false)
    expect(statusesEqual(withoutRecovery, withRecovery)).toBe(false)
  })

  it('separates recovery statuses that differ only in package type, reason, or version', () => {
    expect(
      statusesEqual(withRecovery, {
        ...withRecovery,
        recovery: { ...recovery, packageType: 'rpm' }
      })
    ).toBe(false)
    expect(
      statusesEqual(withRecovery, {
        ...withRecovery,
        recovery: { ...recovery, reason: 'package-install-failed' }
      })
    ).toBe(false)
    expect(
      statusesEqual(withRecovery, { ...withRecovery, recovery: { ...recovery, version: '1.0.62' } })
    ).toBe(false)
    expect(statusesEqual(withRecovery, { ...withRecovery })).toBe(true)
  })

  it('delivers a same-valued recovery recaptured for a new package cycle', () => {
    expect(statusesEqual(withRecovery, { ...withRecovery, recovery: { ...recovery } })).toBe(false)
  })

  it('separates generic errors by version and retryability', () => {
    const error: UpdateStatus = {
      state: 'error',
      message: 'package unavailable',
      version: '1.0.61',
      retryable: false
    }

    expect(statusesEqual(error, { ...error, version: '1.0.62' })).toBe(false)
    expect(statusesEqual(error, { ...error, retryable: true })).toBe(false)
    expect(statusesEqual(error, { ...error })).toBe(true)
  })
})

describe('isReleaseAssetsPublishingFailure', () => {
  it('only matches the explicit release-asset publishing sentinel', () => {
    expect(isReleaseAssetsPublishingFailure('Latest release assets are still publishing')).toBe(
      true
    )
    expect(
      isReleaseAssetsPublishingFailure('Cannot find channel "latest-mac.yml" update info: 404')
    ).toBe(false)
  })
})
