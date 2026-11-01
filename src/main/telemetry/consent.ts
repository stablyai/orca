// Centralize runtime consent precedence. Environment/CI overrides never mutate persisted preference, so removing them restores user intent.

import type { GlobalSettings } from '../../shared/global-settings-types'
import type { TelemetryConsentState } from '../../shared/telemetry-consent-types'

// Retain pending-banner vs explicit-disabled reasons for UI; shared types cross IPC while this re-export preserves main callers.
export type ConsentState = TelemetryConsentState

const CI_ENV_VARS = [
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'CIRCLECI',
  'TRAVIS',
  'BUILDKITE',
  'JENKINS_URL',
  'TEAMCITY_VERSION'
] as const

// Warn once per misconfigured variable so noisy shell profiles cannot flood stderr on every event.
const warnedMisconfigured = new Set<string>()

function warnOnceMisconfigured(name: string, raw: string): void {
  if (warnedMisconfigured.has(name)) {
    return
  }
  warnedMisconfigured.add(name)
  // Misconfiguration belongs on stderr, separate from user-facing output.
  process.stderr.write(
    `[telemetry] ${name}=${JSON.stringify(raw)} is not a recognized truthy value ` +
      `(expected "1" or "true"); treating as unset.\n`
  )
}

function isEnvVarTruthy(name: string): boolean {
  const v = process.env[name]
  if (!v) {
    return false
  }
  const normalized = v.trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') {
    return true
  }
  warnOnceMisconfigured(name, v)
  return false
}

export function _resetMisconfigWarnCacheForTests(): void {
  warnedMisconfigured.clear()
}

function resolveEnvOverride(): ConsentState | null {
  if (isEnvVarTruthy('DO_NOT_TRACK')) {
    return { effective: 'disabled', reason: 'do_not_track' }
  }
  if (isEnvVarTruthy('ORCA_TELEMETRY_DISABLED')) {
    return { effective: 'disabled', reason: 'orca_disabled' }
  }
  // Any nonempty CI marker disables transmission, including non-boolean build IDs.
  if (CI_ENV_VARS.some((v) => process.env[v] !== undefined && process.env[v] !== '')) {
    return { effective: 'disabled', reason: 'ci' }
  }
  return null
}

/** Env/CI overrides beat any stored choice, so consent-change paths must not re-enable or emit through them. */
export function isConsentEnvOverridden(): boolean {
  return resolveEnvOverride() !== null
}

export function resolveConsent(settings: GlobalSettings): ConsentState {
  const envOverride = resolveEnvOverride()
  if (envOverride) {
    return envOverride
  }

  const t = settings.telemetry
  // Missing migrated settings fail closed to pending banner rather than silently enabling transmission.
  if (!t) {
    return { effective: 'pending_banner' }
  }

  if (t.optedIn === true) {
    return { effective: 'enabled' }
  }
  if (t.optedIn === false) {
    return { effective: 'disabled', reason: 'user_opt_out' }
  }

  return { effective: 'pending_banner' }
}
