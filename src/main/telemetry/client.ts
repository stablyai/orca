// All main/IPC telemetry shares shutdown → sampling → burst cap → consent → validation → capture ordering. Cap before settings reads to bound renderer flood cost; disable person profiles per capture because the Node SDK lacks an init-time equivalent.

import { randomUUID } from 'node:crypto'
import type { PostHog } from 'posthog-node'
import type * as events from '../../shared/telemetry/telemetry-event-classification'
import type { OptInVia } from '../../shared/telemetry/schemas/telemetry-property-schemas'
import type { AgentDashboardSurface } from '../../shared/telemetry/schemas/telemetry-agent-dashboard-event-schemas'
import type { Store } from '../persistence/loading-store/store'
import type { GlobalSettings } from '../../shared/settings/global-settings-types'
import { consumeBurstToken, resetBurstCapsForSession } from './burst-cap'
import {
  noteTelemetryEventQueued,
  resetEventSamplingForSession,
  telemetryEventSampleRate
} from './event-sampling'
import * as protectedMilestones from './protected-milestones'
import { experimentCohortProps } from './experiment-cohort-props'
import { getCohortAtEmit } from './cohort-classifier'
import {
  isConsentEnvOverridden,
  resolveConsent,
  recordSharingAtLaunch,
  telemetryWithOptIn
} from './consent'
import * as postHogStart from './posthog-client-start'
import { buildCommonProps, createPostHogClient } from './posthog-transport'
import { captureOptOutBeforeSdkOptOut } from './opt-out-capture'
import { commonPropsSchema, validate } from './validator'

export { shouldOptOutSdkAtInit } from './posthog-transport'

// Compile-time feature flag, independent of the build-identity gate — both must be satisfied to transmit.
// NOTE: config/scripts/verify-telemetry-constants.mjs greps `const TELEMETRY_ENABLED = true|false`; keep that shape or update its regex.
const TELEMETRY_ENABLED = true

// Require both CI-injected official build identity and write key; contributor builds fail closed. Vitest bypasses defines and uses globalThis fallbacks.
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

let posthog: PostHog | null = null
let sessionId: string | null = null
let commonProps: events.CommonProps | null = null
let shuttingDown = false
let storeRef: Store | null = null

let testTransportEnabled = false

type CaptureProperties = Readonly<Record<string, unknown>>

// Banner resolution gates first app_opened; mark and emit atomically.
let appOpenedTrackedThisSession = false
const trackedDashboardActiveDays = new Map<AgentDashboardSurface, number>()

export function initTelemetry(store: Store, scheduleStart: postHogStart.StartScheduler): void {
  // Retain Store even for contributor builds so opt-out persists.
  storeRef = store
  resetBurstCapsForSession()
  resetEventSamplingForSession()
  shuttingDown = false
  // Reset banner/app-open gating each launch, not once per install.
  appOpenedTrackedThisSession = false
  trackedDashboardActiveDays.clear()
  protectedMilestones.bindSession(store, enqueueCapture, isTelemetryEnabled)
  postHogStart.resetStart()
  recordSharingAtLaunch(store)

  if (!TELEMETRY_ENABLED || !IS_OFFICIAL_BUILD || BUILD_IDENTITY === null || WRITE_KEY === null) {
    return
  }

  const settings = store.getSettings()
  const installId = settings.telemetry?.installId
  if (!installId) {
    // Missing migrated install identity must not transmit an absent distinct_id.
    console.warn('[telemetry] installId missing after migration; skipping transport init')
    return
  }

  sessionId = randomUUID()
  commonProps = buildCommonProps(installId, sessionId, BUILD_IDENTITY)

  // Official builds only; contributor builds retain the original announcement behavior.
  Object.assign(commonProps, experimentCohortProps(store))

  // Validate singleton common properties once; invalid identity would collapse installs into one subject.
  const parsedCommon = commonPropsSchema.safeParse(commonProps)
  if (!parsedCommon.success) {
    console.warn('[telemetry] common props failed schema validation; skipping transport init')
    commonProps = null
    return
  }

  posthog = null
  postHogStart.deferStart(WRITE_KEY, store, scheduleStart, ensurePostHogClient)
}

function ensurePostHogClient(): PostHog | null {
  const start = posthog ? null : postHogStart.takeStart()
  if (!start || !storeRef) {
    return posthog
  }
  try {
    // Apply consent as it stands now; the live per-event check already gated each held capture.
    posthog = createPostHogClient(start.writeKey, resolveConsent(storeRef.getSettings()))
    postHogStart.replayHeld(posthog, start.held)
  } catch (err) {
    // Callers include opt-out and quit, which must still complete without a client.
    console.warn('[telemetry] PostHog client failed to start or replay held events:', err)
  }
  return posthog
}

export const isTelemetryInitialized = (): boolean => storeRef !== null

export const telemetrySettings = (): GlobalSettings['telemetry'] | undefined =>
  storeRef?.getSettings().telemetry

/** Lets producers avoid preparing usage payloads when transmission is disabled. */
export function isTelemetryEnabled(): boolean {
  return (
    (testTransportEnabled || (IS_OFFICIAL_BUILD && TELEMETRY_ENABLED)) &&
    !shuttingDown &&
    (posthog !== null || postHogStart.isStartDeferred()) &&
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

export function track<N extends events.EventName>(name: N, props: events.EventProps<N>): boolean {
  if (!testTransportEnabled && (!IS_OFFICIAL_BUILD || !TELEMETRY_ENABLED)) {
    return false
  }

  const now = Date.now()
  const sampleRate = telemetryEventSampleRate(
    name,
    props,
    now,
    (client) => storeRef?.getSettings().telemetry?.chatMessageSentDays?.[client]
  )
  // Reject late IPC while the client flushes.
  if (
    shuttingDown ||
    (!posthog && !postHogStart.isStartDeferred()) ||
    !commonProps ||
    !storeRef ||
    posthog?.optedOut
  ) {
    return false
  }
  const sampledOut = sampleRate < 1 && Math.random() >= sampleRate
  // Milestones derive from every observation, so sampling and budgets cannot hide them.
  const milestoneDay = protectedMilestones.observationDay(name)
  if (sampledOut && milestoneDay === null) {
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
  const dashboardActiveDay = dashboardActiveSurface ? Math.floor(now / 86_400_000) : 0
  // Drop repeat observations before they can exhaust the session-wide event budget.
  if (
    dashboardActiveSurface &&
    (trackedDashboardActiveDays.get(dashboardActiveSurface) ?? -1) >= dashboardActiveDay
  ) {
    return false
  }

  // Cap floods before expensive live consent reads, including opted-out renderers.
  const withinBudget = !sampledOut && consumeBurstToken(name)
  if (!withinBudget && milestoneDay === null) {
    return false
  }

  // Read persisted consent live to respect current preferences/env precedence.
  const settings = storeRef.getSettings()
  const consent = resolveConsent(settings)
  if (consent.effective !== 'enabled') {
    return false
  }

  // Validate schemas, exact keys, enums and bounded strings at one entry point.
  const result = validate(name, props)
  if (!result.ok) {
    return false
  }
  if (milestoneDay !== null) {
    protectedMilestones.record(name, result.props, settings, milestoneDay)
  }
  if (!withinBudget) {
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
      : sampleRate < 1
        ? { sample_rate: sampleRate }
        : {}

  enqueueCapture(name, { ...result.props, ...mainOwnedProps })
  noteTelemetryEventQueued(name, result.props, now, storeRef)
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

function enqueueCapture(name: events.EventName, props: CaptureProperties): void {
  if (!commonProps) {
    throw new Error('telemetry common props missing')
  }
  // Node SDK requires per-capture person-profile suppression.
  const message = {
    distinctId: commonProps.install_id,
    event: name,
    properties: { ...commonProps, ...props, $process_person_profile: false }
  }
  if (posthog) {
    posthog.capture(message)
  } else {
    postHogStart.holdCapture(message, ensurePostHogClient)
  }
}

export async function setOptIn(via: OptInVia, optedIn: boolean): Promise<void> {
  if (!storeRef) {
    return
  }
  // Start before consent changes: opt-out must flush held events and enqueue its own event first.
  ensurePostHogClient()
  const settings = storeRef.getSettings()
  // Deep-merge opt-in without clobbering installation identity or cohort.
  storeRef.updateSettings(
    { telemetry: telemetryWithOptIn(settings, optedIn) },
    { notifyListeners: true }
  )

  const client = posthog
  if (optedIn) {
    if (client && !isConsentEnvOverridden()) {
      await client.optIn()
    }
    // Settings opt-in also starts an observable session that needs an adoption denominator.
    trackAppOpenedOnce()
    track('telemetry_opted_in', { via })
  } else {
    if (!client || isConsentEnvOverridden()) {
      return
    }
    try {
      if (!shuttingDown && commonProps) {
        await captureOptOutBeforeSdkOptOut(client, commonProps, via)
      }
    } catch (err) {
      console.warn('[telemetry] telemetry_opted_out capture failed before SDK opt-out:', err)
    } finally {
      await client.optOut()
    }
  }
}

// Banner dismissal persists silent opt-in: emit app_opened but no consent-change event. Keep distinct surfaces named explicitly.
export async function persistBannerAcknowledgeWithoutEmitting(): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  storeRef.updateSettings(
    { telemetry: telemetryWithOptIn(settings, true) },
    { notifyListeners: true }
  )
  if (posthog && !isConsentEnvOverridden()) {
    await posthog.optIn()
  }
  // Banner resolution is first app_opened eligibility; re-enable SDK before capture.
  trackAppOpenedOnce()
}

export function trackAppOpenedOnce(): void {
  if (appOpenedTrackedThisSession) {
    return
  }
  // Repo count zero identifies the pre-repo cohort (onboarding-funnel-cohort-addendum.md).
  appOpenedTrackedThisSession = track('app_opened', { ...getCohortAtEmit() })
}

export async function shutdownTelemetry(): Promise<void> {
  // Fence before flushing so late IPC cannot enqueue.
  shuttingDown = true
  const instance = postHogStart.hasSendableHeldCaptures() ? ensurePostHogClient() : posthog
  postHogStart.resetStart()
  if (!instance) {
    return
  }
  try {
    // Bound quit delay to two seconds.
    await instance.shutdown(2_000)
  } catch (err) {
    // Telemetry failure must never prevent quit.
    console.warn('[telemetry] shutdown error (ignored):', err)
  }
}

export function _setStoreForTests(store: Store | null): void {
  storeRef = store
}
