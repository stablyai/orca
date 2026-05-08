// IPC surface for the telemetry transport. Four handlers, all renderer-
// facing: one pipe (`telemetry:track`), one consent-mutation
// (`telemetry:setOptIn`), one silent-persist for the banner ✕ path
// (`telemetry:acknowledgeBanner`), and one read-only getter for effective
// consent state (`telemetry:getConsentState`, used by the Privacy pane to
// render env-var blocked-state helper text). Every track call from the
// renderer lands here and funnels into the same `track()` the main-
// originated events go through — the validator is the single enforcement
// point, not this file.
//
// Threat model: the renderer renders attacker-controllable content (agent
// output, MCP responses, file contents, markdown, diff views). An
// XSS-equivalent rendering bug in any of those surfaces gives an attacker
// the ability to invoke `window.api.telemetry*` at will. The handlers
// below are designed to fail closed under that model:
//
//   - Strict main-side type narrows. TypeScript types do not survive IPC
//     serialization; the renderer can pass anything across the wire, so we
//     narrow at the boundary. Non-string `name` or non-object `props` on
//     `track` → drop silently. Non-boolean `optedIn` on `setOptIn` → drop.
//   - Consent-mutation rate limit. A real user flips the Privacy pane
//     toggle a handful of times at most; beyond 5 per session it is either
//     a UI bug or a compromised renderer. Drop silently past the cap.
//     Applies to `acknowledgeBanner` as well — that path also mutates
//     persisted consent, so it lives under the same per-session ceiling.
//
// `via` derivation: the renderer does NOT pass `via` across the wire. That
// design was rejected specifically because a compromised renderer could
// misreport `via`, muddying the one signal we use to distinguish
// first-launch interactions from settings flips. Main derives `via` from
// fields main already owns (`existedBeforeTelemetryRelease`, current
// `optedIn`) before any state mutation. The two product paths map cleanly
// to the two schema values (`first_launch_banner` for the existing-user
// notice's "Turn off" button; `settings` for everything else — new users
// have no first-launch surface, so their opt-outs always come through
// Settings).

import { ipcMain } from 'electron'
import { consumeConsentMutationToken } from '../telemetry/burst-cap'
import { persistBannerAcknowledgeWithoutEmitting, setOptIn, track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { resolveConsent, type ConsentState } from '../telemetry/consent'
import type { Store } from '../persistence'
import { isCohortExtendedEvent } from '../../shared/telemetry-events'
import type { EventName, EventProps } from '../../shared/telemetry-events'
import type { OptInVia } from '../../shared/telemetry-events'

// Module-level store reference, populated by `registerTelemetryHandlers`.
// The handlers need a synchronous read of `settings.telemetry` at call time
// to derive `via` before any mutation runs — threading the store through
// every handler closure is the least-surprising shape for that, and it
// mirrors how other core-handlers accept the store explicitly.
let storeRef: Store | null = null

/**
 * Derive the `via` discriminator for a `telemetry:setOptIn` call from
 * main-owned state. Called BEFORE any state mutation so the cohort + opt-in
 * snapshot reflects the pre-click world.
 *
 * Two cases (mirrors the product surfaces defined in telemetry-plan.md):
 *   - existing-user notice "Turn off" → `'first_launch_banner'`
 *     (existedBeforeTelemetryRelease=true, optedIn=null, incoming false)
 *   - any other flip → `'settings'`
 *     (Privacy pane, post-first-launch mutations, etc.)
 *
 * New users never reach a `'first_launch_banner'` tag — their cohort marker
 * is false and they see no first-launch surface at all (see telemetry-plan.md
 * §First-launch experience). Any consent flip they make routes through
 * Settings → Privacy and tags as `'settings'`.
 *
 * Note: the notice's ✕ (silent acknowledge) path does NOT come through this
 * function — it routes through `telemetry:acknowledgeBanner` and
 * `persistBannerAcknowledgeWithoutEmitting`, which intentionally does not
 * emit. Derivation here would tag it as `'first_launch_banner'` and emit
 * `telemetry_opted_in`, which the ✕-as-silent-acknowledge semantics
 * forbid.
 */
function deriveOptInVia(store: Store, incomingOptedIn: boolean): OptInVia {
  const telemetry = store.getSettings().telemetry
  const existedBefore = telemetry?.existedBeforeTelemetryRelease === true
  const currentOptedIn = telemetry?.optedIn

  // Existing-user cohort, notice still pending. The only surface that calls
  // `setOptIn` in this state is the FirstLaunchBanner's "Turn off" click;
  // the ✕ path does not route here (it goes through
  // `telemetry:acknowledgeBanner`). We additionally narrow on
  // `incomingOptedIn === false` as a defensive guard: a compromised
  // renderer could otherwise call `telemetrySetOptIn(true)` in this
  // pre-notice state and synthesize a spurious
  // `telemetry_opted_in { via: 'first_launch_banner' }`, which the
  // ✕-as-silent-acknowledge contract forbids. Falling through to
  // 'settings' for the true case keeps the forbidden tag unreachable
  // from IPC.
  if (existedBefore && currentOptedIn === null && incomingOptedIn === false) {
    return 'first_launch_banner'
  }

  return 'settings'
}

export function registerTelemetryHandlers(store: Store): void {
  storeRef = store

  ipcMain.handle('telemetry:track', (_event, name: unknown, props: unknown): void => {
    // Strict input typing: non-string names are dropped at the boundary
    // before the validator even sees them. The validator would also drop
    // (unknown event name), but the main-side narrow keeps the attack
    // surface minimal — a flood of bogus payloads does not exercise the
    // Zod parser for no reason.
    if (typeof name !== 'string') {
      return
    }
    // `props` may legitimately be omitted; treat `undefined`/`null` as an
    // empty object before the validator. Anything else non-object (e.g.
    // a string, a number) is a boundary violation.
    if (props !== null && props !== undefined && typeof props !== 'object') {
      return
    }
    // Inject cohort here, at the IPC entry, only for events whose schemas
    // declare `nth_repo_added` (see `COHORT_EXTENDED` in telemetry-events.ts).
    // The selectivity is load-bearing: schemas are `.strict()`, so adding
    // `nth_repo_added` to an event that does not declare it would fail Zod
    // validation and silently drop the entire event. The renderer call sites
    // stay synchronous (matching the existing fire-and-forget shape) and
    // avoid an extra IPC round-trip to fetch cohort.
    const eventName = name as EventName
    const baseProps = (props ?? {}) as Record<string, unknown>
    const finalProps = isCohortExtendedEvent(eventName)
      ? { ...baseProps, ...getCohortAtEmit() }
      : baseProps
    // The casts to `EventName` / `EventProps<EventName>` here are
    // pass-through only — this file does NOT pretend the renderer's
    // name/props are type-safe. The validator inside `track()` is the
    // single enforcement point at runtime; these casts only feed the
    // typed channel that the validator will re-check.
    track(eventName, finalProps as EventProps<EventName>)
  })

  ipcMain.handle('telemetry:setOptIn', (_event, optedIn: unknown): Promise<void> | void => {
    // Strict input typing — renderer can pass anything over IPC.
    if (typeof optedIn !== 'boolean') {
      return
    }
    // Check storeRef BEFORE consuming a consent-mutation token. If the store
    // isn't ready (pre-registration race, test harness misuse, a future
    // refactor), consuming a token here would burn budget for a no-op and
    // eventually block legitimate mutations from the same session.
    if (!storeRef) {
      return
    }
    // Consent-mutation bucket: ≤5 per session. See `burst-cap.ts`. Does not
    // apply to main-originated consent mutations that bypass IPC (none
    // today; this is future-proofing rather than a current code path).
    if (!consumeConsentMutationToken()) {
      return
    }
    // Read settings BEFORE any state mutation. The derivation must see the
    // pre-mutation world so an existing user clicking "Turn off" on the
    // notice still presents as (optedIn=null → false) at the moment `via`
    // is computed, not (optedIn=false → false) after the write lands.
    const via = deriveOptInVia(storeRef, optedIn)
    return setOptIn(via, optedIn)
  })

  // Read-only view of the effective consent state. The Privacy pane needs
  // this to render the correct helper text when an env var
  // (DO_NOT_TRACK / ORCA_TELEMETRY_DISABLED / CI) blocks transmission —
  // those variables are main-side process state and the renderer has no
  // way to read them directly. No rate limit: this is a synchronous getter
  // with no mutation, bounded in work by one `resolveConsent` call.
  ipcMain.handle('telemetry:getConsentState', (): ConsentState => {
    if (!storeRef) {
      // Fail closed — a missing store means we cannot honor the user's
      // stored preference, so surface pending_banner rather than a
      // misleading 'enabled'. The renderer treats pending_banner like a
      // disabled state in the UI.
      return { effective: 'pending_banner' }
    }
    return resolveConsent(storeRef.getSettings())
  })

  ipcMain.handle('telemetry:acknowledgeBanner', (_event): Promise<void> | void => {
    // Banner ✕ — persist `optedIn = true` without emitting a telemetry opt-in
    // event. The acknowledge still unlocks `app_opened`, but this outcome
    // cannot route through `telemetry:setOptIn` because the derivation above
    // would tag it `first_launch_banner` and fire `telemetry_opted_in`.
    //
    // Check storeRef BEFORE consuming a consent-mutation token, mirroring
    // the setOptIn handler's guard above — see that comment for why
    // burning a token on a no-op blocks legitimate mutations later in
    // the same session.
    if (!storeRef) {
      return
    }
    // State-precondition guard: this channel is ONLY valid when the notice
    // is pending resolution — i.e. existing-user cohort
    // (existedBeforeTelemetryRelease=true) with optedIn still null. Any
    // other state is either a UI bug (the notice should not be reachable
    // post-resolution) or a compromised renderer trying to silently flip
    // optedIn=true after the user already opted out, which would bypass
    // the audit signal entirely. `deriveOptInVia` already applies the
    // symmetric guard on `telemetry:setOptIn` (it refuses to tag a true
    // flip as `first_launch_banner`); this narrows the silent-persist
    // attack surface on the acknowledge channel to exactly the state the
    // notice contract covers. Must run BEFORE the token consume — same
    // "don't burn a token on a no-op" reasoning as the !storeRef guard
    // above.
    const telemetry = storeRef.getSettings().telemetry
    if (telemetry?.existedBeforeTelemetryRelease !== true || telemetry?.optedIn !== null) {
      return
    }
    // This path still goes through `consumeConsentMutationToken` — a
    // compromised renderer could otherwise burn through the
    // acknowledgeBanner channel to force unbounded settings-file writes,
    // which is a CPU/disk amplification vector even without any event
    // emission.
    if (!consumeConsentMutationToken()) {
      return
    }
    return persistBannerAcknowledgeWithoutEmitting()
  })
}

// Test-only reset for the module-level store reference. Tests can
// re-register handlers against a fresh mock store without leaking state
// between describes.
export function _resetStoreForTests(): void {
  storeRef = null
}
