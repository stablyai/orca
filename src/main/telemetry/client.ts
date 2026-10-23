// Main-process telemetry transport: one posthog-node client, one `track()` entry that every
// event (main + IPC) funnels through. The ordering inside `track()` — shutdown gate, burst cap,
// consent, validator, capture — MUST be preserved: burst cap runs before consent so a compromised
// opted-out renderer can't force a settings read per event.
// `$process_person_profile: false` is attached per capture because posthog-node has no init-time
// equivalent of posthog-js's `person_profiles: 'identified_only'` (no PostHog person per install_id).

import { randomUUID } from 'node:crypto'
import type { PostHog } from 'posthog-node'
import type { CommonProps, EventName, EventProps, OptInVia } from '../../shared/telemetry-events'
import type { AgentDashboardSurface } from '../../shared/telemetry-agent-dashboard-event-schemas'
import type { Store } from '../persistence'
import { consumeBurstToken, resetBurstCapsForSession } from './burst-cap'
import { getCohortAtEmit } from './cohort-classifier'
import { resolveConsent } from './consent'
import { buildCommonProps, createPostHogClient, waitForCaptureEnqueue } from './posthog-transport'
import { commonPropsSchema, validate } from './validator'

export { shouldOptOutSdkAtInit } from './posthog-transport'

// Compile-time feature flag, independent of the build-identity gate — both must be satisfied to transmit.
// NOTE: config/scripts/verify-telemetry-constants.mjs greps `const TELEMETRY_ENABLED = true|false`; keep that shape or update its regex.
const TELEMETRY_ENABLED = true

// Eligible to transmit only if CI injected BOTH build-identity and write key; either alone fails closed, with no runtime env-var override (dev/contributor builds get `null`).
// The `globalThis` reads are for vitest, which skips electron-vite's `define` pass — resolving to `IS_OFFICIAL_BUILD === false` there.
const BUILD_IDENTITY: 'stable' | 'rc' | null =
  typeof ORCA_BUILD_IDENTITY !== 'undefined'
    ? ORCA_BUILD_IDENTITY
    : ((globalThis as { ORCA_BUILD_IDENTITY?: 'stable' | 'rc' | null }).ORCA_BUILD_IDENTITY ?? null)
const WRITE_KEY: string | null =
  typeof ORCA_POSTHOG_WRITE_KEY !== 'undefined'
    ? ORCA_POSTHOG_WRITE_KEY
    : ((globalThis as { ORCA_POSTHOG_WRITE_KEY?: string | null }).ORCA_POSTHOG_WRITE_KEY ?? null)
const IS_OFFICIAL_BUILD: boolean =
  (BUILD_IDENTITY === 'stable' || BUILD_IDENTITY === 'rc') &&
  typeof WRITE_KEY === 'string' &&
  WRITE_KEY.length > 0

// Module-level singletons — one Store / process / telemetry session; threading `store` everywhere buys nothing.
let posthog: PostHog | null = null
let sessionId: string | null = null
let commonProps: CommonProps | null = null
let shuttingDown = false
let storeRef: Store | null = null

// Test-only transport-gate override (`_enableTransportForTests`) so tests exercise the full pipeline without a real CI build.
let testTransportEnabled = false

// First-launch `app_opened` gate: no events transmit until the banner resolves; keep mark+emit atomic.
let appOpenedTrackedThisSession = false
const trackedDashboardActiveDays = new Map<AgentDashboardSurface, number>()

export function initTelemetry(store: Store): void {
  // Set unconditionally so `setOptIn` can persist opt-out to disk even on contributor / non-official builds.
  storeRef = store
  resetBurstCapsForSession()
  shuttingDown = false
  // Reset per session: the "no app_opened until banner resolution" invariant is per-launch, not per-install.
  appOpenedTrackedThisSession = false
  trackedDashboardActiveDays.clear()

  if (!TELEMETRY_ENABLED || !IS_OFFICIAL_BUILD || BUILD_IDENTITY === null || WRITE_KEY === null) {
    return
  }

  const settings = store.getSettings()
  const installId = settings.telemetry?.installId
  if (!installId) {
    // Migration guarantees installId; if missing, don't transmit with an absent distinct_id.
    console.warn('[telemetry] installId missing after migration; skipping transport init')
    return
  }

  sessionId = randomUUID()
  commonProps = buildCommonProps(installId, sessionId, BUILD_IDENTITY)

  const languageCohort = settings.telemetry?.onboardingLanguageCohort
  if (languageCohort === 'control' || languageCohort === 'treatment') {
    commonProps.onboarding_language_v1 = languageCohort
  }

  // Fail-closed: a bad `install_id` (e.g. empty from a migration bug) would collapse all events into one distinct_id.
  // Validated once here (not per `track()`): `commonProps` is a session-lifetime singleton that can't drift.
  const parsedCommon = commonPropsSchema.safeParse(commonProps)
  if (!parsedCommon.success) {
    console.warn('[telemetry] common props failed schema validation; skipping transport init')
    commonProps = null
    return
  }

  posthog = createPostHogClient(WRITE_KEY, resolveConsent(settings))
}

/** Lets producers avoid preparing usage payloads when transmission is disabled. */
export function isTelemetryEnabled(): boolean {
  return (
    (testTransportEnabled || (IS_OFFICIAL_BUILD && TELEMETRY_ENABLED)) &&
    !shuttingDown &&
    posthog !== null &&
    commonProps !== null &&
    storeRef !== null &&
    resolveConsent(storeRef.getSettings()).effective === 'enabled'
  )
}

export function hasTrackedAgentDashboardActiveToday(props: unknown): boolean {
  if (!props || typeof props !== 'object' || !('surface' in props)) {
    return false
  }
  const surface = props.surface
  return (
    (surface === 'in_window' || surface === 'popout') &&
    (trackedDashboardActiveDays.get(surface) ?? -1) >= Math.floor(Date.now() / 86_400_000)
  )
}

// No-op in contributor / non-official builds; only official stable/rc builds (CI-injected `ORCA_BUILD_IDENTITY` + `ORCA_POSTHOG_WRITE_KEY`) transmit.
export function track<N extends EventName>(name: N, props: EventProps<N>): boolean {
  if (!testTransportEnabled && (!IS_OFFICIAL_BUILD || !TELEMETRY_ENABLED)) {
    return false
  }

  // (1) Shutdown gate: late IPC arrivals must not enqueue against a flushing client.
  if (shuttingDown) {
    return false
  }
  if (!posthog || !commonProps || !storeRef || posthog.optedOut) {
    return false
  }

  const dashboardActiveSurface =
    name === 'agent_dashboard_active' &&
    props !== null &&
    typeof props === 'object' &&
    'surface' in props &&
    (props.surface === 'in_window' || props.surface === 'popout')
      ? props.surface
      : null
  const dashboardActiveDay = dashboardActiveSurface ? Math.floor(Date.now() / 86_400_000) : 0
  // Drop repeat observations before they can exhaust the session-wide event budget.
  if (
    dashboardActiveSurface &&
    (trackedDashboardActiveDays.get(dashboardActiveSurface) ?? -1) >= dashboardActiveDay
  ) {
    return false
  }

  // (2) Burst cap before consent: the O(1) cap drops floods before the costly settings read, so a compromised opted-out renderer can't burn CPU.
  if (!consumeBurstToken(name)) {
    return false
  }

  // (3) Consent resolve — reads live settings every call so it can't drift from persisted state / env-var precedence.
  const settings = storeRef.getSettings()
  const consent = resolveConsent(settings)
  if (consent.effective !== 'enabled') {
    return false
  }

  // (4) Validator — single enforcement point for schema, enum, key set, and length caps.
  const result = validate(name, props)
  if (!result.ok) {
    return false
  }
  if (dashboardActiveSurface) {
    if (settings.experimentalAgentDashboardPopout !== true) {
      return false
    }
    const savedDay = settings.telemetry?.agentDashboardActiveDays?.[dashboardActiveSurface] ?? -1
    if (savedDay >= dashboardActiveDay) {
      trackedDashboardActiveDays.set(dashboardActiveSurface, savedDay)
      return false
    }
  }
  const mainOwnedProps =
    name === 'app_opened'
      ? {
          agent_dashboard_enabled: settings.experimentalAgentDashboardPopout === true
        }
      : {}

  // (5) Capture. `$process_person_profile: false` stops posthog-node creating a person per install_id (no init-time equivalent).
  posthog.capture({
    distinctId: commonProps.install_id,
    event: name,
    properties: {
      ...commonProps,
      ...result.props,
      ...mainOwnedProps,
      $process_person_profile: false
    }
  })
  if (dashboardActiveSurface && settings.telemetry) {
    trackedDashboardActiveDays.set(dashboardActiveSurface, dashboardActiveDay)
    try {
      storeRef.updateSettings({
        telemetry: {
          ...settings.telemetry,
          agentDashboardActiveDays: {
            ...settings.telemetry.agentDashboardActiveDays,
            [dashboardActiveSurface]: dashboardActiveDay
          }
        }
      })
    } catch (err) {
      console.warn('[telemetry] failed to persist dashboard daily usage limit', err)
    }
  }
  return true
}

export async function setOptIn(via: OptInVia, optedIn: boolean): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  // Deep-merge (persistence.ts:552) so flipping `optedIn` won't clobber `installId` / `existedBeforeTelemetryRelease`.
  storeRef.updateSettings(
    {
      telemetry: {
        ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
        optedIn
      }
    },
    { notifyListeners: true }
  )

  const client = posthog
  if (optedIn) {
    if (client) {
      await client.optIn()
    }
    // Settings opt-in also starts an observable session that needs an adoption denominator.
    trackAppOpenedOnce()
    track('telemetry_opted_in', { via })
  } else {
    if (!client) {
      return
    }
    // Fire before disabling the SDK — the one event that must transmit against the new preference. Capture directly (not
    // `track()`, which would drop it on `user_opt_out`); await enqueue since posthog-node captures async and must confirm before optOut().
    try {
      if (!shuttingDown && commonProps && consumeBurstToken('telemetry_opted_out')) {
        const validated = validate('telemetry_opted_out', { via })
        if (validated.ok) {
          const uuid = randomUUID()
          const enqueued = waitForCaptureEnqueue(client, 'telemetry_opted_out', uuid)
          client.capture({
            distinctId: commonProps.install_id,
            event: 'telemetry_opted_out',
            uuid,
            properties: {
              ...commonProps,
              ...validated.props,
              $process_person_profile: false
            }
          })
          if (!(await enqueued)) {
            console.warn('[telemetry] telemetry_opted_out did not enqueue before SDK opt-out')
          }
        }
      }
    } catch (err) {
      console.warn('[telemetry] telemetry_opted_out capture failed before SDK opt-out:', err)
    } finally {
      await client.optOut()
    }
  }
}

// Banner ✕: silent persisted opt-in. Separate from `setOptIn` because that always emits a
// `telemetry_opted_in/out` event; here `app_opened` fires but no opt-in event does. Don't add a
// `via`/emit param — give a new silent-opt-in surface its own named function.
export async function persistBannerAcknowledgeWithoutEmitting(): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  // Fallback only used if the `telemetry` block is absent (migration invariant broken); updateSettings deep-merges it (persistence.ts:560).
  storeRef.updateSettings(
    {
      telemetry: {
        ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
        optedIn: true
      }
    },
    { notifyListeners: true }
  )
  if (posthog) {
    await posthog.optIn()
  }
  // Why: banner resolution is the first eligible moment for app_opened; SDK re-enabled above so capture sees the new consent.
  trackAppOpenedOnce()
}

export function trackAppOpenedOnce(): void {
  if (appOpenedTrackedThisSession) {
    return
  }
  // Why: `nth_repo_added: 0` marks the session-zero / pre-repo cohort. See docs/onboarding-funnel-cohort-addendum.md.
  appOpenedTrackedThisSession = track('app_opened', { ...getCohortAtEmit() })
}

export async function shutdownTelemetry(): Promise<void> {
  // Set the gate before flush so late IPC-arrived tracks drop instead of enqueuing mid-flush.
  shuttingDown = true
  const instance = posthog
  if (!instance) {
    return
  }
  try {
    // Bounded flush caps at 2s, so quit delay rises by at most that.
    await instance.shutdown(2_000)
  } catch (err) {
    // Telemetry must never crash the app on quit. Swallow.
    console.warn('[telemetry] shutdown error (ignored):', err)
  }
}

// Test-only introspection: `_`-prefixed helpers inject a fake PostHog and observe captures; not a runtime API.

export function _setPostHogClientForTests(client: PostHog | null): void {
  posthog = client
}

export function _setCommonPropsForTests(props: CommonProps | null): void {
  commonProps = props
}

export function _setStoreForTests(store: Store | null): void {
  storeRef = store
}

export function _setShuttingDownForTests(value: boolean): void {
  shuttingDown = value
}

export function _enableTransportForTests(enabled: boolean): void {
  testTransportEnabled = enabled
}

export function _resetFirstAppOpenedFiredForTests(): void {
  appOpenedTrackedThisSession = false
}
