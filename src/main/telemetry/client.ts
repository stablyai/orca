// Main-process telemetry transport: one posthog-node client, one `track()` entry that every
// event (main + IPC) funnels through. The ordering inside `track()` — shutdown gate, burst cap,
// consent, validator, capture — MUST be preserved: burst cap runs before consent so a compromised
// opted-out renderer can't force a settings read per event.
// `$process_person_profile: false` is attached per capture because posthog-node has no init-time
// equivalent of posthog-js's `person_profiles: 'identified_only'` (no PostHog person per install_id).

import { randomUUID } from 'node:crypto'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { app } from 'electron'
import { PostHog } from 'posthog-node'
import type { CommonProps, EventName, EventProps, OptInVia } from '../../shared/telemetry-events'
import type { Store } from '../persistence'
import { consumeBurstToken, resetBurstCapsForSession } from './burst-cap'
import { getCohortAtEmit } from './cohort-classifier'
import { resolveConsent, type ConsentState } from './consent'
import { commonPropsSchema, validate } from './validator'

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

const OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS = 1_000

// Test-only transport-gate override (`_enableTransportForTests`) so tests exercise the full pipeline without a real CI build.
let testTransportEnabled = false

// First-launch `app_opened` gate: no events transmit until the banner resolves; keep mark+emit atomic.
let appOpenedTrackedThisSession = false

function buildCommonProps(installId: string, sid: string, channel: 'stable' | 'rc'): CommonProps {
  // Don't truncate here; the validator's `.max(64)` is authoritative, so an over-long string drops rather than being silently masked.
  return {
    app_version: app.getVersion(),
    platform: osPlatform(),
    arch: osArch(),
    os_release: osRelease(),
    install_id: installId,
    session_id: sid,
    orca_channel: channel
  }
}

export function initTelemetry(store: Store): void {
  // Set unconditionally so `setOptIn` can persist opt-out to disk even on contributor / non-official builds.
  storeRef = store
  resetBurstCapsForSession()
  shuttingDown = false
  // Reset per session: the "no app_opened until banner resolution" invariant is per-launch, not per-install.
  appOpenedTrackedThisSession = false

  if (!TELEMETRY_ENABLED || !IS_OFFICIAL_BUILD) {
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
  commonProps = buildCommonProps(
    installId,
    sessionId,
    // Non-null here: `IS_OFFICIAL_BUILD` gated this branch to the `'stable' | 'rc'` arm.
    BUILD_IDENTITY as 'stable' | 'rc'
  )

  // Fail-closed: a bad `install_id` (e.g. empty from a migration bug) would collapse all events into one distinct_id.
  // Validated once here (not per `track()`): `commonProps` is a session-lifetime singleton that can't drift.
  const parsedCommon = commonPropsSchema.safeParse(commonProps)
  if (!parsedCommon.success) {
    console.warn('[telemetry] common props failed schema validation; skipping transport init')
    commonProps = null
    return
  }

  posthog = new PostHog(WRITE_KEY as string, {
    host: 'https://us.i.posthog.com',
    flushAt: 20,
    flushInterval: 10_000,
    // Strip SDK-auto GeoIP / client-IP enrichment; our wire is exactly CommonProps ∪ EventProps ∪ a small allow-list.
    disableGeoip: true,
    // Bumped from the default 1000 (drops oldest-first past cap) to 5000 to tolerate long-offline sessions.
    maxQueueSize: 5000
  })

  if (shouldOptOutSdkAtInit(resolveConsent(settings))) {
    posthog.optOut()
  }
}

/**
 * Whether to flip the PostHog SDK's in-memory `optedOut` flag at boot.
 *
 * True for DISABLED cohorts only, re-applied every boot (the flag doesn't persist) so any direct
 * `posthog.capture()` bypassing `track()` still drops for an opted-out user. Deliberately excludes
 * `pending_banner`: the direct `telemetry_opted_out` capture in `setOptIn(_, false)` must not drop,
 * or we'd lose the one signal that the opt-out flow works.
 */
export function shouldOptOutSdkAtInit(consent: ConsentState): boolean {
  return consent.effective === 'disabled'
}

function waitForCaptureEnqueue(client: PostHog, event: EventName, uuid: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let stopListening: (() => void) | null = null
    let timeout: ReturnType<typeof setTimeout> | null = null

    const settle = (enqueued: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      if (timeout) {
        clearTimeout(timeout)
      }
      stopListening?.()
      resolve(enqueued)
    }

    // Why: posthog-node capture() enqueues async; this SDK event is the durable boundary before optOut().
    stopListening = client.on('capture', (payload: unknown) => {
      if (!payload || typeof payload !== 'object') {
        return
      }
      const message = payload as { event?: unknown; uuid?: unknown }
      if (message.event === event && message.uuid === uuid) {
        settle(true)
      }
    })

    timeout = setTimeout(() => settle(false), OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS)
  })
}

// No-op in contributor / non-official builds; only official stable/rc builds (CI-injected `ORCA_BUILD_IDENTITY` + `ORCA_POSTHOG_WRITE_KEY`) transmit.
export function track<N extends EventName>(name: N, props: EventProps<N>): void {
  if (!testTransportEnabled && (!IS_OFFICIAL_BUILD || !TELEMETRY_ENABLED)) {
    return
  }

  // (1) Shutdown gate: late IPC arrivals must not enqueue against a flushing client.
  if (shuttingDown) {
    return
  }
  if (!posthog || !commonProps || !storeRef) {
    return
  }

  // (2) Burst cap before consent: the O(1) cap drops floods before the costly settings read, so a compromised opted-out renderer can't burn CPU.
  if (!consumeBurstToken(name)) {
    return
  }

  // (3) Consent resolve — reads live settings every call so it can't drift from persisted state / env-var precedence.
  const consent = resolveConsent(storeRef.getSettings())
  if (consent.effective !== 'enabled') {
    return
  }

  // (4) Validator — single enforcement point for schema, enum, key set, and length caps.
  const result = validate(name, props)
  if (!result.ok) {
    return
  }

  // (5) Capture. `$process_person_profile: false` stops posthog-node creating a person per install_id (no init-time equivalent).
  posthog.capture({
    distinctId: commonProps.install_id,
    event: name,
    properties: {
      ...commonProps,
      ...result.props,
      $process_person_profile: false
    }
  })
}

export async function setOptIn(via: OptInVia, optedIn: boolean): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  const telemetryBeforeUpdate = settings.telemetry
  const wasPendingBanner =
    telemetryBeforeUpdate?.existedBeforeTelemetryRelease === true &&
    telemetryBeforeUpdate.optedIn === null
  // Deep-merge (persistence.ts:552) so flipping `optedIn` won't clobber `installId` / `existedBeforeTelemetryRelease`.
  storeRef.updateSettings({
    telemetry: {
      ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
      optedIn
    }
  })

  const client = posthog
  if (optedIn) {
    if (client) {
      await client.optIn()
    }
    if (wasPendingBanner) {
      trackAppOpenedOnce()
    }
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
  storeRef.updateSettings({
    telemetry: {
      ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
      optedIn: true
    }
  })
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
  appOpenedTrackedThisSession = true
  // Why: `nth_repo_added: 0` marks the session-zero / pre-repo cohort. See docs/onboarding-funnel-cohort-addendum.md.
  track('app_opened', { ...getCohortAtEmit() })
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

export function _getSessionIdForTests(): string | null {
  return sessionId
}

export function _enableTransportForTests(enabled: boolean): void {
  testTransportEnabled = enabled
}

export function _resetFirstAppOpenedFiredForTests(): void {
  appOpenedTrackedThisSession = false
}
