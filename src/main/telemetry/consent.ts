// Pure consent resolver. Every call site (PR 2+) goes through `resolveConsent`
// so env-var / CI detection is centralized — no scattered `process.env.CI`
// checks can drift out of sync with the documented precedence list.
//
// Env-var and CI paths are non-persistent: they set effective consent at
// runtime only and never mutate `GlobalSettings.telemetry.optedIn`. Unsetting
// the variable on the next launch restores the user's stored preference.

import type { GlobalSettings } from '../../shared/types'

// Discriminated union instead of a boolean: the Privacy pane (PR 3) needs the
// `reason` to render the correct "disabled because X" helper text, and the
// first-launch banner must distinguish "existing user awaiting decision"
// (`pending_banner`) from "user explicitly opted out" (`disabled`). A boolean
// would force the UI to re-derive that, re-introducing the scattered env
// checks this module exists to eliminate.
export type ConsentState =
  | { effective: 'enabled' }
  | {
      effective: 'disabled'
      reason: 'do_not_track' | 'orca_disabled' | 'ci' | 'user_opt_out'
    }
  | { effective: 'pending_banner' }

// Precedence for the `disabled` branches is documented alongside
// `resolveConsent` below and in docs/telemetry-plan.md §"Env vars and consent
// precedence". Keep this list in sync with that table.
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

// Track which env-var names have already produced a misconfiguration warning
// so a noisy shell profile that sets e.g. `DO_NOT_TRACK=yes` does not spam
// stderr on every resolve call.
const warnedMisconfigured = new Set<string>()

function warnOnceMisconfigured(name: string, raw: string): void {
  if (warnedMisconfigured.has(name)) {
    return
  }
  warnedMisconfigured.add(name)
  // Stderr, not stdout — consent misconfiguration is an operator signal, not
  // user-facing output. Mirrors the skills.sh-style bug note in the plan doc:
  // a value like `0` / `yes` / `on` / `FALSE` silently no-oping is exactly
  // the class of bug we want surfaced.
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

// Exposed for tests only — resets the one-shot warning dedupe so separate
// tests can each exercise the misconfiguration path independently.
export function _resetMisconfigWarnCacheForTests(): void {
  warnedMisconfigured.clear()
}

export function resolveConsent(settings: GlobalSettings): ConsentState {
  // Precedence 1: community standard kill switch. Always wins.
  if (isEnvVarTruthy('DO_NOT_TRACK')) {
    return { effective: 'disabled', reason: 'do_not_track' }
  }
  // Precedence 2: product-specific kill switch.
  if (isEnvVarTruthy('ORCA_TELEMETRY_DISABLED')) {
    return { effective: 'disabled', reason: 'orca_disabled' }
  }
  // Precedence 3: CI detection. Any presence (not just truthy) counts — many
  // CI systems set `CI=true` but some legacy ones just set it to an empty
  // string or a build ID, and none of those are human intent to opt in.
  if (CI_ENV_VARS.some((v) => process.env[v] !== undefined && process.env[v] !== '')) {
    return { effective: 'disabled', reason: 'ci' }
  }

  const t = settings.telemetry
  // Defensive: after the PR 1 migration in `Store.load()`, every settings
  // object has `telemetry` populated. If we somehow read a settings object
  // that predates migration, fail closed to `pending_banner` (no transmit)
  // rather than defaulting on.
  if (!t) {
    return { effective: 'pending_banner' }
  }

  if (t.optedIn === true) {
    return { effective: 'enabled' }
  }
  if (t.optedIn === false) {
    return { effective: 'disabled', reason: 'user_opt_out' }
  }

  // `optedIn === null` — existing-user cohort awaiting banner resolution.
  return { effective: 'pending_banner' }
}
