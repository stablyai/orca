import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveConsent, _resetMisconfigWarnCacheForTests } from './consent'

// The resolver reads telemetry only; keep the unrelated settings surface out of this fixture.
function settingsWithTelemetry(telemetry: GlobalSettings['telemetry']): GlobalSettings {
  return { telemetry } as unknown as GlobalSettings
}

// Restore env explicitly because writes survive module mock boundaries.
const ENV_KEYS_UNDER_TEST = [
  'DO_NOT_TRACK',
  'ORCA_TELEMETRY_DISABLED',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
]

describe('resolveConsent', () => {
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = {}
    for (const k of ENV_KEYS_UNDER_TEST) {
      savedEnv[k] = process.env[k]
      delete process.env[k]
    }
    _resetMisconfigWarnCacheForTests()
  })

  afterEach(() => {
    for (const k of ENV_KEYS_UNDER_TEST) {
      if (savedEnv[k] === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = savedEnv[k]
      }
    }
  })

  it('returns do_not_track when DO_NOT_TRACK=1', () => {
    process.env.DO_NOT_TRACK = '1'
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({
      effective: 'disabled',
      reason: 'do_not_track'
    })
  })

  it('returns do_not_track when DO_NOT_TRACK=true (case/whitespace insensitive)', () => {
    process.env.DO_NOT_TRACK = ' TRUE '
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({
      effective: 'disabled',
      reason: 'do_not_track'
    })
  })

  it('returns orca_disabled when ORCA_TELEMETRY_DISABLED=1', () => {
    process.env.ORCA_TELEMETRY_DISABLED = '1'
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({
      effective: 'disabled',
      reason: 'orca_disabled'
    })
  })

  it('prefers do_not_track over orca_disabled when both are set', () => {
    process.env.DO_NOT_TRACK = '1'
    process.env.ORCA_TELEMETRY_DISABLED = '1'
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({
      effective: 'disabled',
      reason: 'do_not_track'
    })
  })

  it.each([
    ['CI', 'true'],
    ['GITHUB_ACTIONS', 'true'],
    ['GITLAB_CI', 'true'],
    ['CIRCLECI', 'true'],
    ['TRAVIS', 'true'],
    ['BUILDKITE', 'true'],
    ['JENKINS_URL', 'http://ci.example.com/'],
    ['TEAMCITY_VERSION', '2023.11']
  ])('returns ci when %s is set', (name, value) => {
    process.env[name] = value
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({
      effective: 'disabled',
      reason: 'ci'
    })
  })

  it('does not treat CI="" (empty string) as a CI environment', () => {
    process.env.CI = ''
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({ effective: 'enabled' })
  })

  it('treats a misconfigured DO_NOT_TRACK=0 as unset (not truthy)', () => {
    // String zero must not disable telemetry through ordinary JavaScript truthiness.
    process.env.DO_NOT_TRACK = '0'
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({ effective: 'enabled' })
  })

  it('returns enabled when optedIn is true (new-user cohort after migration)', () => {
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: true,
          installId: 'x',
          existedBeforeTelemetryRelease: false
        })
      )
    ).toEqual({ effective: 'enabled' })
  })

  it('returns user_opt_out when optedIn is false', () => {
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: false,
          installId: 'x',
          existedBeforeTelemetryRelease: true
        })
      )
    ).toEqual({ effective: 'disabled', reason: 'user_opt_out' })
  })

  it('returns pending_banner when optedIn is null (existing-user cohort awaiting banner)', () => {
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: null,
          installId: 'x',
          existedBeforeTelemetryRelease: true
        })
      )
    ).toEqual({ effective: 'pending_banner' })
  })

  it('returns pending_banner when telemetry settings are absent (pre-migration defensive path)', () => {
    expect(resolveConsent(settingsWithTelemetry(undefined))).toEqual({
      effective: 'pending_banner'
    })
  })

  it('env-var override wins over a stored pending_banner state', () => {
    process.env.ORCA_TELEMETRY_DISABLED = '1'
    expect(
      resolveConsent(
        settingsWithTelemetry({
          optedIn: null,
          installId: 'x',
          existedBeforeTelemetryRelease: true
        })
      )
    ).toEqual({ effective: 'disabled', reason: 'orca_disabled' })
  })
})
