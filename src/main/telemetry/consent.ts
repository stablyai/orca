// Centralize runtime consent precedence. Environment/CI overrides never mutate persisted preference, so removing them restores user intent.

import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import type { TelemetryConsentState } from '../../shared/telemetry/telemetry-consent-types'
import type { Store } from '../persistence/loading-store/store'
import { formatLocalDay, shiftDay } from '../usage/reporting/range-query/usage-calendar-range'

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

export function resolveTelemetryDisableEnv(): ConsentState | null {
  if (isEnvVarTruthy('DO_NOT_TRACK')) {
    return { effective: 'disabled', reason: 'do_not_track' }
  }
  if (isEnvVarTruthy('ORCA_TELEMETRY_DISABLED')) {
    return { effective: 'disabled', reason: 'orca_disabled' }
  }
  return null
}

function resolveEnvOverride(): ConsentState | null {
  const disabled = resolveTelemetryDisableEnv()
  if (disabled) {
    return disabled
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

/** Opt-in update that keeps install identity and stamps the day sharing turns on from off or pending. */
export function telemetryWithOptIn(
  settings: GlobalSettings,
  optedIn: boolean,
  now = new Date()
): NonNullable<GlobalSettings['telemetry']> {
  const turnsOn = optedIn && resolveConsent(settings).effective !== 'enabled'
  return {
    // Only broken migration can omit telemetry; updateSettings deep-merges fallback state.
    ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
    optedIn,
    // An env override keeps sharing off, so the day it is lifted still needs stamping.
    ...(turnsOn
      ? { sharingResumedDay: formatLocalDay(now), sharingWasOff: isConsentEnvOverridden() }
      : {}),
    ...(optedIn ? {} : { sharingWasOff: true })
  }
}

/** Env overrides can turn sharing off and on between launches, so each launch records the change. */
export function telemetryAtLaunch(
  settings: GlobalSettings,
  now = new Date()
): NonNullable<GlobalSettings['telemetry']> | null {
  const telemetry = settings.telemetry
  if (!telemetry) {
    return null
  }
  const on = resolveConsent(settings).effective === 'enabled'
  // Unset after an upgrade: earlier launches may have had sharing off, so stamp once.
  if (telemetry.sharingWasOff !== undefined && on === !telemetry.sharingWasOff) {
    return null
  }
  return on
    ? { ...telemetry, sharingWasOff: false, sharingResumedDay: formatLocalDay(now) }
    : { ...telemetry, sharingWasOff: true }
}

export function recordSharingAtLaunch(store: Store): void {
  try {
    const telemetry = telemetryAtLaunch(store.getSettings())
    if (telemetry) {
      store.updateSettings({ telemetry })
    }
  } catch (err) {
    console.warn('[telemetry] failed to record sharing state at launch', err)
  }
}

/** Days up to the one sharing last turned back on may hold activity from while it was off; they are never sent.
 *  Day strings may be local or UTC and zones can change, so one day of margin covers the shift. */
export function isBeforeSharingResumed(
  telemetry: GlobalSettings['telemetry'] | undefined,
  day: string
): boolean {
  const resumedDay = telemetry?.sharingResumedDay
  return resumedDay !== undefined && day <= shiftDay(resumedDay, 1)
}
