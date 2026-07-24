// IPC surface for telemetry: `track`, `setOptIn`, `acknowledgeBanner`, and read-only
// `getConsentState`. Renderer track calls funnel into the same `track()` as main-originated
// events; the validator there is the single enforcement point, not this file.
//
// Threat model: the renderer displays attacker-controllable content (agent output, MCP
// responses, markdown, diffs), so an XSS-equivalent bug lets an attacker call
// `window.api.telemetry*`. These handlers fail closed: strict main-side type narrows (TS
// types don't survive IPC), a ≤5/session consent-mutation cap (covers `acknowledgeBanner`
// too), and `via` derived from main-owned state — never passed over the wire, so a
// compromised renderer can't misreport it.

import { ipcMain } from 'electron'
import { consumeConsentMutationToken } from '../telemetry/burst-cap'
import { persistBannerAcknowledgeWithoutEmitting, setOptIn, track } from '../telemetry/client'
import { getCohortAtEmit } from '../telemetry/cohort-classifier'
import { getOnboardingCohortAtEmit } from '../telemetry/onboarding-cohort-classifier'
import { resolveConsent, type ConsentState } from '../telemetry/consent'
import type { Store } from '../persistence'
import { isCohortExtendedEvent, isOnboardingEvent } from '../../shared/telemetry-events'
import type { EventName, EventProps } from '../../shared/telemetry-events'
import type { OptInVia } from '../../shared/telemetry-events'

// Module-level store ref: handlers need a synchronous `settings.telemetry` read to derive `via` before any mutation.
let storeRef: Store | null = null

const MAIN_OWNED_TELEMETRY_EVENTS = new Set<EventName>([
  'app_starred_orca',
  'star_nag_outcome',
  'feature_interaction_usage_bucket_reached'
])

/**
 * Derive the `via` discriminator for `telemetry:setOptIn` from main-owned state.
 * Called BEFORE any mutation so the snapshot reflects the pre-click world.
 * Existing-user notice "Turn off" → `first_launch_banner`; any other flip → `settings`
 * (new users have no first-launch surface, so their opt-outs always tag `settings`; see telemetry-plan.md).
 * (The ✕ silent-acknowledge path routes through `telemetry:acknowledgeBanner`, not here.)
 */
function deriveOptInVia(store: Store, incomingOptedIn: boolean): OptInVia {
  const telemetry = store.getSettings().telemetry
  const existedBefore = telemetry?.existedBeforeTelemetryRelease === true
  const currentOptedIn = telemetry?.optedIn

  // The `incomingOptedIn === false` narrow stops a compromised renderer synthesizing a spurious first_launch_banner opt-in.
  if (existedBefore && currentOptedIn === null && incomingOptedIn === false) {
    return 'first_launch_banner'
  }

  return 'settings'
}

export function registerTelemetryHandlers(store: Store): void {
  storeRef = store

  ipcMain.handle('telemetry:track', (_event, name: unknown, props: unknown): void => {
    // Drop non-string names at the boundary so a flood of bogus payloads never reaches the Zod validator.
    if (typeof name !== 'string') {
      return
    }
    // `props` is optional (undefined/null → {} below); reject any other non-object at the boundary.
    if (props !== null && props !== undefined && typeof props !== 'object') {
      return
    }
    const eventName = name as EventName
    // Why: these events are main-owned; renderer IPC emitting them would let compromised content spoof product outcomes.
    if (MAIN_OWNED_TELEMETRY_EVENTS.has(eventName)) {
      return
    }
    // Inject cohort props only for schemas that declare them: schemas are `.strict()`, so an extra prop on any other event fails Zod and drops it.
    const baseProps = (props ?? {}) as Record<string, unknown>
    const withRepoCohort = isCohortExtendedEvent(eventName)
      ? { ...baseProps, ...getCohortAtEmit() }
      : baseProps
    const finalProps = isOnboardingEvent(eventName)
      ? { ...withRepoCohort, ...getOnboardingCohortAtEmit() }
      : withRepoCohort
    // Casts are pass-through only; `track()`'s validator is the single runtime enforcement point, not these casts.
    track(eventName, finalProps as EventProps<EventName>)
  })

  ipcMain.handle('telemetry:setOptIn', (_event, optedIn: unknown): Promise<void> | void => {
    // Strict input typing — renderer can pass anything over IPC.
    if (typeof optedIn !== 'boolean') {
      return
    }
    // Check storeRef before consuming a token — burning one on a no-op would eventually block legitimate mutations this session.
    if (!storeRef) {
      return
    }
    // Consent-mutation bucket: ≤5 per session (see `burst-cap.ts`).
    if (!consumeConsentMutationToken()) {
      return
    }
    // Derive `via` BEFORE the write so it sees the pre-mutation state (optedIn still null for an existing user's "Turn off").
    const via = deriveOptInVia(storeRef, optedIn)
    return setOptIn(via, optedIn)
  })

  // Read-only getter: lets the Privacy pane see env-var blocks (DO_NOT_TRACK/ORCA_TELEMETRY_DISABLED/CI), which are main-side state the renderer can't read.
  ipcMain.handle('telemetry:getConsentState', (): ConsentState => {
    if (!storeRef) {
      // Fail closed: no store means we can't honor the stored preference, so surface pending_banner, not a misleading 'enabled'.
      return { effective: 'pending_banner' }
    }
    return resolveConsent(storeRef.getSettings())
  })

  ipcMain.handle('telemetry:acknowledgeBanner', (_event): Promise<void> | void => {
    // Banner ✕: persist optedIn=true WITHOUT emitting — routing through setOptIn would fire telemetry_opted_in, which the silent-acknowledge contract forbids.
    if (!storeRef) {
      return
    }
    // Only valid while the notice is pending (existedBefore=true, optedIn=null); any other state is a renderer silently flipping optedIn after opt-out.
    const telemetry = storeRef.getSettings().telemetry
    if (telemetry?.existedBeforeTelemetryRelease !== true || telemetry?.optedIn !== null) {
      return
    }
    // Rate-limit even this silent path: unbounded acknowledge calls are a disk-write amplification vector.
    if (!consumeConsentMutationToken()) {
      return
    }
    return persistBannerAcknowledgeWithoutEmitting()
  })
}

// Test-only reset so tests can re-register handlers without leaking store state between describes.
export function _resetStoreForTests(): void {
  storeRef = null
}
