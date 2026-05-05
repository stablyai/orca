// Existing-user first-launch notice. Shown to users whose cohort marker is
// `existedBeforeTelemetryRelease === true` and whose `optedIn` is still
// `null`, i.e. users who installed Orca before the telemetry release and
// have not yet resolved the notice.
//
// Why existing users see a notice at all (and new users do not): pre-
// telemetry users installed Orca under a "no telemetry" social contract,
// so default-on for them would be a silent policy flip. New users are
// covered by the install-time disclosure and receive no first-launch UI —
// see telemetry-plan.md §First-launch experience.
//
// Three actions, two semantics:
//   - "Got it" and the ✕ in the corner → silent acknowledge. Both persist
//     `optedIn: true`, fire no opt-in event, route through
//     `window.api.telemetryAcknowledgeBanner()` to a dedicated main-side
//     channel so no `via` derivation can tag this path. Two surfaces for
//     the same action because the ✕ alone is easy to miss; "Got it" is
//     the discoverable primary, ✕ is the keyboard/notification-style
//     escape. Either way the user sees the notice, chooses not to
//     intervene, and is opted in silently.
//   - "Turn off" → explicit opt-out. Routes through
//     `window.api.telemetrySetOptIn(false)`; main derives
//     `via = 'first_launch_banner'` from the pre-mutation state
//     (existedBeforeTelemetryRelease=true, optedIn=null, incoming=false)
//     and fires `telemetry_opted_out { via: 'first_launch_banner' }`
//     BEFORE disabling the SDK — the one signal that tells us the
//     opt-out flow is working must not be silenced by the opt-out it
//     announces.
//   - "Privacy policy" link → opens the privacy doc URL, no state change,
//     no dismiss.
//
// No auto-dismiss, no delayed re-ask: once resolved (Got it / ✕ / Turn
// off), the notice never returns, because the cohort condition
// (`optedIn === null`) clears in all three resolving paths.

import { useState } from 'react'
import { X } from 'lucide-react'

import { Button } from './ui/button'
import { acknowledgeBanner, PRIVACY_URL, setOptIn as telemetrySetOptIn } from '../lib/telemetry'

type FirstLaunchBannerProps = {
  onResolve: () => void
  fetchSettings: () => Promise<void>
}

export function FirstLaunchBanner({
  onResolve,
  fetchSettings
}: FirstLaunchBannerProps): React.JSX.Element {
  // Double-click guard. Without this, a fast second click on "Turn off"
  // would re-enter telemetrySetOptIn(false); on the second call, main's
  // deriveOptInVia sees currentOptedIn=false (just persisted by click 1)
  // and falls through to the 'settings' branch, producing one opt-out
  // intent tagged as two different `via` values. The acknowledge paths
  // are guarded symmetrically — a second Got-it/✕ click would be a
  // wasted IPC round-trip, but the guard also blocks a Turn-off click
  // arriving mid-flight after an acknowledge (or vice versa).
  const [inFlight, setInFlight] = useState(false)

  const handleAcknowledge = async (): Promise<void> => {
    if (inFlight) {
      return
    }
    setInFlight(true)
    // Main's `telemetry:acknowledgeBanner` handler persists `optedIn: true`
    // without an opt-in event and intentionally does NOT broadcast
    // `settings:changed` (see src/main/ipc/telemetry.ts). Without an
    // explicit `fetchSettings()` refresh, the renderer store would retain
    // `optedIn: null` and PrivacyPane would keep rendering its pending-
    // banner helper text until the next full relaunch. Mirror
    // PrivacyPane's handleToggle pattern which refetches for the same
    // reason before surfacing UI changes.
    await acknowledgeBanner()
    await fetchSettings()
    onResolve()
  }

  const handleTurnOff = async (): Promise<void> => {
    if (inFlight) {
      return
    }
    setInFlight(true)
    // Opt-out fires `telemetry_opted_out { via: 'first_launch_banner' }`
    // BEFORE the SDK disable — main enforces that ordering inside
    // `setOptIn` (client.ts). The renderer just needs to route through
    // `telemetrySetOptIn(false)` so the IPC handler derives the correct
    // `via` and fires the event.
    await telemetrySetOptIn(false)
    await fetchSettings()
    onResolve()
  }

  return (
    // Fixed-top strip so the notice overlays whatever is beneath without
    // shifting the rest of the layout. `top-2` hugs the top edge of the
    // window; on macOS the titlebar is drawn over the same region but the
    // banner stays below the traffic lights via centering + narrow width.
    // The notice is non-modal and intentionally does not occlude the main
    // content — clicks pass through to below-notice regions outside this
    // box.
    //
    // `relative` is load-bearing: the absolutely-positioned ✕ anchors to
    // this container.
    <div
      className="fixed left-1/2 top-2 z-40 flex w-[min(44.625rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-4 rounded-lg border border-border bg-card/95 py-3 pl-4 pr-3 shadow-lg backdrop-blur"
      role="region"
      aria-label="Telemetry notice"
      aria-live="polite"
    >
      {/* Text column — title + body stack on the left, takes remaining
          width so the action column never pushes copy into a wrap. */}
      <div className="flex-1 space-y-0.5 pr-1 text-sm">
        <p className="font-medium leading-snug">Help us decide what to build next</p>
        <p className="text-xs leading-snug text-muted-foreground">
          Anonymous counts of which features you use help us prioritize what to build. No file
          contents, prompts, terminal output, or anything that identifies you. Change anytime in
          Settings &rarr; Privacy &amp; Telemetry.{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void window.api.shell.openUrl(PRIVACY_URL)}
          >
            Privacy policy
          </button>
          .
        </p>
      </div>
      {/* Action column — vertically centered against the text block.
          "Got it" is the affirmative primary so it reads as the easy
          path; "Turn off" is the secondary outline so the destructive
          (from telemetry's perspective) action requires an explicit
          choice. ✕ stays in the corner as a familiar escape and to
          satisfy keyboard/notification-style dismiss expectations. */}
      <div className="flex shrink-0 items-center gap-2 self-center pr-6">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTurnOff}
          disabled={inFlight}
          className="border-border/60 text-muted-foreground"
        >
          Opt out
        </Button>
        <Button size="sm" onClick={handleAcknowledge} disabled={inFlight}>
          Got it
        </Button>
      </div>
      {/* aria-label says "Dismiss" — the action persists silent opt-in,
          not just hides the UI. */}
      <button
        type="button"
        aria-label="Dismiss notice"
        onClick={handleAcknowledge}
        disabled={inFlight}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
