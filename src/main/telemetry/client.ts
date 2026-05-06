// Main-process telemetry transport. One `posthog-node` client per process,
// one source of truth for common props, one `track()` entry that every event
// (main-originated AND IPC-arrived) funnels through. The validator in
// `validator.ts` is the single gate that protects the wire from malformed
// or over-sized payloads; the burst cap in `burst-cap.ts` protects against
// runaway useEffects and a compromised renderer.
//
// Ordering inside `track()` — MUST be preserved:
//   1. shutdown gate        — will-quit already set `shuttingDown = true`;
//                             late IPC arrivals drop, never crash.
//   2. burst cap            — O(1). Runs BEFORE consent resolve so an
//                             opted-out user whose renderer is compromised
//                             cannot burn handler CPU by forcing a
//                             settings read + consent evaluation on every
//                             attempt.
//   3. consent resolve      — reads the live settings, never a cached
//                             boolean. Env-var / CI / opt-out all funnel
//                             through here.
//   4. validator            — schema-level safeParse. Fail-closed.
//   5. posthog.capture      — the only place this module calls into the
//                             vendor SDK.
//
// `$process_person_profile: false` is attached on every capture because
// posthog-node has no init-time equivalent of posthog-js's
// `person_profiles: 'identified_only'` — without the per-capture flag, the
// server SDK would materialize a PostHog person per install_id, which we
// explicitly do not want for anonymous-only events.

import { randomUUID } from 'node:crypto'
import { arch as osArch, platform as osPlatform, release as osRelease } from 'node:os'
import { app } from 'electron'
import { PostHog } from 'posthog-node'
import type { CommonProps, EventName, EventProps, OptInVia } from '../../shared/telemetry-events'
import type { Store } from '../persistence'
import { consumeBurstToken, resetBurstCapsForSession } from './burst-cap'
import { resolveConsent, type ConsentState } from './consent'
import { commonPropsSchema, validate } from './validator'

// Compile-time feature flag. PR 2 shipped with this `false` so the SDK was
// wired but no event transmitted. PR 3 flips it to `true`. Independent of
// the build-identity gate below: both must be satisfied to transmit, so
// flipping the flag alone still leaves contributor builds silent.
//
// NOTE: config/scripts/verify-telemetry-constants.mjs greps this declaration
// shape (`const TELEMETRY_ENABLED = true|false`) to gate release verification.
// If you refactor this (e.g. let, export, computed-from-env, moved into a
// config object), update the regex in that script too.
const TELEMETRY_ENABLED = true

// Eligible-to-transmit only if the CI release pipeline injected BOTH the
// build-identity constant and a write key. One without the other is treated
// as a pipeline misconfiguration and fails closed. Contributor / `pnpm dev`
// / third-party rebuilds get literal `null` from electron-vite's `define`,
// so `IS_OFFICIAL_BUILD` evaluates `false` at module load. There is no
// runtime env-var fallback.
//
// The `globalThis` dance exists for the vitest harness. `declare const`
// lets TypeScript type-check against the substituted symbols, but vitest
// does not run electron-vite's `define` pass, so the identifiers are
// undefined at test-runtime. Routing the read through `globalThis` gives
// us the compile-time substitution in production and a safe `undefined`
// in tests — both of which resolve to `IS_OFFICIAL_BUILD === false`, which
// is the fail-closed default we want anywhere outside an official CI build.
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

// Module-level singletons. There is exactly one Store / one main process /
// one telemetry session at a time; threading `store` through every export
// is verbose without buying anything.
let posthog: PostHog | null = null
let sessionId: string | null = null
let commonProps: CommonProps | null = null
let shuttingDown = false
let storeRef: Store | null = null

const OPT_OUT_CAPTURE_ENQUEUE_TIMEOUT_MS = 1_000

// Test-only override for the transport gate. Set by `_enableTransportForTests`
// so the client.test.ts suite can exercise the full pipeline (burst cap,
// consent, validator, capture) without waiting on a real CI build. Left
// `false` in production; an accidental call from non-test code would still
// be bounded by `resolveConsent` + the validator.
let testTransportEnabled = false

// First-launch `app_opened` session gate. The existing-user banner contract is:
// no events transmit until the notice resolves. Keep "mark" and "emit"
// atomic so no path can accidentally suppress the event without firing it.
let appOpenedTrackedThisSession = false

function buildCommonProps(installId: string, sid: string, channel: 'stable' | 'rc'): CommonProps {
  // `.max(64)` on every free-form string field in `commonPropsSchema` is the
  // upper bound; node's platform / arch / release strings are always well
  // under that in practice. We do not truncate here because the validator's
  // schema cap is the authoritative check — truncating pre-validator would
  // silently mask an unexpected-long-string case we want to see as a drop.
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
  // Set `storeRef` unconditionally so `setOptIn` can persist consent
  // changes even in console-mirror builds — opt-out must still write to
  // disk on a contributor laptop, not just on official builds.
  storeRef = store
  resetBurstCapsForSession()
  shuttingDown = false
  // Gate reset per session: the "no app_opened until banner resolution"
  // invariant is per-launch, not across the lifetime of the install.
  appOpenedTrackedThisSession = false

  if (!TELEMETRY_ENABLED || !IS_OFFICIAL_BUILD) {
    return
  }

  const settings = store.getSettings()
  const installId = settings.telemetry?.installId
  if (!installId) {
    // Migration guarantees this is set; if it isn't, we're in an invariant-
    // violation state and must not transmit with a missing distinct_id.
    console.warn('[telemetry] installId missing after migration; skipping transport init')
    return
  }

  sessionId = randomUUID()
  commonProps = buildCommonProps(
    installId,
    sessionId,
    // Non-null at this point: `IS_OFFICIAL_BUILD` gated this branch and
    // narrows the identity constant to the `'stable' | 'rc'` arm.
    BUILD_IDENTITY as 'stable' | 'rc'
  )

  // Fail-closed on bad common props — the validator is the single enforcement
  // point for wire shape, including common props. A bad `install_id` (e.g.
  // empty string from a migration bug) would collapse all events into one
  // distinct_id, so we must refuse to initialize transport rather than ship
  // malformed identity on every capture.
  //
  // Validated once here at init — NOT on every `track()` call — because
  // `commonProps` is a module-level singleton built exactly once from inputs
  // that do not change across the session (app version, OS, install_id,
  // session_id, channel). Re-validating per event would be wasted work on
  // a value that cannot drift. If a future refactor makes `commonProps`
  // mutable mid-session, move this check accordingly.
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
    // Strip every auto-attached property we do not want on our wire: no
    // GeoIP, no client IP enrichment. Our wire is exactly
    // `CommonProps ∪ EventProps ∪ a small allow-list of SDK auto-props`.
    disableGeoip: true,
    // Default is 1000; past that, the SDK drops oldest-first. Bumped to
    // 5000 to tolerate long-offline sessions (flights, VPN-down, tunnels).
    // The per-session 1,000-event ceiling in `track()` caps normal
    // operation well below this; the 5000 slots are the absolute ceiling
    // across any conceivable offline duration.
    maxQueueSize: 5000
  })

  if (shouldOptOutSdkAtInit(resolveConsent(settings))) {
    posthog.optOut()
  }
}

/**
 * Decide whether to flip the PostHog SDK's in-memory `optedOut` flag at boot.
 *
 * Applied to DISABLED cohorts only (`user_opt_out` / CI / DO_NOT_TRACK /
 * ORCA_TELEMETRY_DISABLED). The SDK flag does not persist across process
 * restarts, so we re-apply on every boot as defense-in-depth: any direct
 * `posthog.capture()` that bypasses `track()` (and therefore bypasses the
 * consent gate in this module) must still drop at the SDK boundary for a
 * user who has opted out.
 *
 * Intentionally NOT applied to `pending_banner`: the existing-user Turn-off
 * path in `setOptIn(_, false)` does a direct `posthog.capture()` for the
 * `telemetry_opted_out { via: 'first_launch_banner' }` signal, bypassing
 * `track()` (see the long comment in the opt-out branch below explaining
 * why). If the SDK were already opted-out at that point, the capture would
 * silently drop inside posthog-core's `enqueue()` — losing the one signal
 * that tells us the opt-out flow works. `track()`'s own consent gate
 * (`resolveConsent() !== 'enabled'`) still drops every other event while
 * the cohort is `pending_banner`, so there is no risk of stray transmission
 * during the pre-banner window.
 *
 * Exported for tests; production has exactly one call site above.
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

    // Why: posthog-node's capture() prepares/enqueues asynchronously; this
    // public SDK event is the durable boundary we need before calling optOut().
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

// In `pnpm dev` and any contributor / non-official build, `track()` is a
// no-op: it returns immediately without transmitting, logging, or running
// the burst-cap / consent / validator pipeline. Telemetry only flows in
// official stable/rc builds where CI injects `ORCA_BUILD_IDENTITY` and
// `ORCA_POSTHOG_WRITE_KEY`.
export function track<N extends EventName>(name: N, props: EventProps<N>): void {
  if (!testTransportEnabled && (!IS_OFFICIAL_BUILD || !TELEMETRY_ENABLED)) {
    return
  }

  // (1) Shutdown gate. Late IPC arrivals should not attempt to enqueue
  // against a client that is actively flushing.
  if (shuttingDown) {
    return
  }
  if (!posthog || !commonProps || !storeRef) {
    return
  }

  // (2) Burst cap BEFORE consent. A compromised renderer of an opted-out
  // user should not be able to burn CPU by forcing a settings read and a
  // `resolveConsent` evaluation on every attempt — the cap is O(1), the
  // consent resolve reads the live settings object. This ordering is the
  // difference between "opt-out is a free drop" and "opt-out is a cheap
  // drop at the cost of a settings read per event."
  if (!consumeBurstToken(name)) {
    return
  }

  // (3) Consent resolve — reads live settings every call; never a cached
  // module-level boolean that could drift from the persisted state or the
  // env-var precedence.
  const consent = resolveConsent(storeRef.getSettings())
  if (consent.effective !== 'enabled') {
    return
  }

  // (4) Validator — single enforcement point for schema, enum, strict key
  // set, and per-string length caps.
  const result = validate(name, props)
  if (!result.ok) {
    return
  }

  // (5) Capture. `$process_person_profile: false` is the server-SDK
  // equivalent of posthog-js's `person_profiles: 'identified_only'` —
  // attached per-event because posthog-node has no init-time option.
  // Without this, posthog-node materializes a PostHog person per
  // `install_id`, which we explicitly do not want for anonymous-only
  // events.
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
  // `updateSettings` is a partial-merge (see persistence.ts:552). The Store's
  // `telemetry` field is deep-merged there specifically so an `optedIn` flip
  // from the Privacy pane / consent flow does not clobber `installId` or
  // `existedBeforeTelemetryRelease`.
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
    // Fire opt-out event BEFORE disabling the SDK. This is the one event
    // that transmits against the user's new preference — the user chose to
    // tell us they are opting out, and that single signal is what tells us
    // the opt-out flow is working.
    //
    // Capture directly (not via `track()`) because `updateSettings` above
    // just flipped `optedIn` to `false`; `track()` would re-read settings,
    // call `resolveConsent`, and drop on `user_opt_out` — at which point the
    // one signal that tells us the opt-out flow works would be silent.
    // Burst cap + validator still run; consent is the only gate bypassed,
    // and it is bypassed exactly once per user per session at most (IPC
    // consent-mutation cap is 5/session).
    //
    // posthog-node prepares capture() asynchronously, so "call capture
    // before optOut" is not enough; wait until the SDK confirms enqueue.
    // We do not wait for network flush here — the SDK queue and shutdown
    // flush own delivery, while the enqueue boundary owns the optOut race.
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

// Banner ✕ path. Writes `optedIn = true` permanently without emitting a
// telemetry opt-in event. `app_opened` still fires because resolving the
// banner is the first point where this session is eligible to transmit.
// That outcome cannot route through `setOptIn()` — `setOptIn()` always
// fires a `telemetry_opted_in/out` event and the IPC handler always
// derives a non-`null` `via` value, which would tag a ✕ click as
// `first_launch_banner` + `telemetry_opted_in`. The ✕-as-silent-
// acknowledge contract is explicit: the user did not explicitly opt in,
// they declined to intervene, so no opt-in event transmits.
//
// So this primitive exists as a named, non-overloaded code path: persist
// the opt-in, unlock the SDK, and fire the once-per-session app-opened event.
// The corresponding `telemetry:acknowledgeBanner` IPC channel
// routes renderer ✕ clicks here instead of through `telemetry:setOptIn`.
//
// Do NOT extend this with a `via` parameter or emission flag. If a future
// surface also needs a silent persisted opt-in, give it its own named
// function rather than overloading this one — the grep'ability of
// `persistBannerAcknowledgeWithoutEmitting` is the whole point.
export async function persistBannerAcknowledgeWithoutEmitting(): Promise<void> {
  if (!storeRef) {
    return
  }
  const settings = storeRef.getSettings()
  // Defensive merge mirrors `setOptIn`: updateSettings deep-merges the
  // telemetry block (persistence.ts:560), so the fallback object here only
  // matters if the migration invariant has been violated and `telemetry`
  // is somehow absent — in which case we still want to persist an opt-in
  // rather than no-op.
  storeRef.updateSettings({
    telemetry: {
      ...(settings.telemetry ?? { installId: '', existedBeforeTelemetryRelease: true }),
      optedIn: true
    }
  })
  if (posthog) {
    await posthog.optIn()
  }
  // Why: resolving the banner is the first eligible moment for app_opened.
  // Re-enable the SDK first so capture sees the new consent state.
  trackAppOpenedOnce()
}

export function trackAppOpenedOnce(): void {
  if (appOpenedTrackedThisSession) {
    return
  }
  appOpenedTrackedThisSession = true
  track('app_opened', {})
}

export async function shutdownTelemetry(): Promise<void> {
  // Setting the shutdown gate is synchronous and cheap — it matters that
  // late IPC-arrived tracks hit it before the bounded flush starts.
  shuttingDown = true
  const instance = posthog
  if (!instance) {
    return
  }
  try {
    // PostHog's bounded flush caps at 2s. Observed quit delay goes up by at
    // most that on top of the current daemon-teardown budget.
    await instance.shutdown(2_000)
  } catch (err) {
    // Telemetry must never crash the app on quit. Swallow.
    console.warn('[telemetry] shutdown error (ignored):', err)
  }
}

// ── Test-only introspection ─────────────────────────────────────────────
//
// The test suite needs to inject a fake PostHog and observe capture calls
// without touching the network. Kept under a `_`-prefixed name so it is
// obvious in code review that this is not a runtime API.

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
