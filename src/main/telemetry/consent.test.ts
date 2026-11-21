import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
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
})
