// First-launch telemetry notice shown only to pre-telemetry users (existedBeforeTelemetryRelease && optedIn === null),
// who installed under a "no telemetry" contract; new users are covered by install-time disclosure.
// Got it / ✕ silently opt in; "Turn off" explicitly opts out. See telemetry-plan.md §First-launch experience.

import { useState } from 'react'
import { X } from 'lucide-react'

import { Button } from './ui/button'
import { acknowledgeBanner, PRIVACY_URL, setOptIn as telemetrySetOptIn } from '../lib/telemetry'
import { useMountedRef } from '@/hooks/useMountedRef'
import { translate } from '@/i18n/i18n'

type FirstLaunchBannerProps = {
  onResolve: () => void
  fetchSettings: () => Promise<void>
}

export function FirstLaunchBanner({
  onResolve,
  fetchSettings
}: FirstLaunchBannerProps): React.JSX.Element {
  // Double-click guard: a second Turn-off click would re-derive `via` as 'settings', mis-tagging one opt-out as two.
  const [inFlight, setInFlight] = useState(false)
  const mountedRef = useMountedRef()

  const handleAcknowledge = async (): Promise<void> => {
    if (inFlight) {
      return
    }
    setInFlight(true)
    // acknowledgeBanner doesn't broadcast settings:changed, so refetch or the store keeps optedIn: null.
    try {
      await acknowledgeBanner()
      await fetchSettings()
      if (mountedRef.current) {
        onResolve()
      }
    } finally {
      // Reset inFlight so a fetchSettings rejection doesn't leave every button permanently disabled.
      if (mountedRef.current) {
        setInFlight(false)
      }
    }
  }

  const handleTurnOff = async (): Promise<void> => {
    if (inFlight) {
      return
    }
    setInFlight(true)
    // Route through telemetrySetOptIn(false) so main derives `via` and fires telemetry_opted_out before disabling the SDK.
    try {
      await telemetrySetOptIn(false)
      await fetchSettings()
      if (mountedRef.current) {
        onResolve()
      }
    } finally {
      if (mountedRef.current) {
        setInFlight(false)
      }
    }
  }

  return (
    // Fixed non-modal overlay; centered + narrow so it clears the macOS traffic lights.
    // `relative` is load-bearing: the absolutely-positioned ✕ anchors to this container.
    <div
      className="fixed left-1/2 top-2 z-40 flex w-[min(44.625rem,calc(100vw-2rem))] -translate-x-1/2 items-start gap-4 rounded-lg border border-border bg-card/95 py-3 pl-4 pr-3 shadow-lg backdrop-blur"
      role="region"
      aria-label={translate('auto.components.FirstLaunchBanner.fcbee32f08', 'Telemetry notice')}
      aria-live="polite"
    >
      {/* Text column — flex-1 so the action column never wraps the copy. */}
      <div className="flex-1 space-y-0.5 pr-1 text-sm">
        <p className="font-medium leading-snug">
          {translate(
            'auto.components.FirstLaunchBanner.9784b4d7bc',
            'Help us decide what to build next'
          )}
        </p>
        <p className="text-xs leading-snug text-muted-foreground">
          {translate(
            'auto.components.FirstLaunchBanner.958d2cc31b',
            'Anonymous counts of which features you use help us prioritize what to build. No file contents, prompts, terminal output, or anything that identifies you. Change anytime in Settings -> Privacy & Telemetry.'
          )}{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground"
            onClick={() => void window.api.shell.openUrl(PRIVACY_URL)}
          >
            {translate('auto.components.FirstLaunchBanner.d1deebb050', 'Privacy policy')}
          </button>
          .
        </p>
      </div>
      {/* Action column — "Got it" primary reads as the easy path; "Turn off" outline marks the explicit opt-out. */}
      <div className="flex shrink-0 items-center gap-2 self-center pr-6">
        <Button
          variant="outline"
          size="sm"
          onClick={handleTurnOff}
          disabled={inFlight}
          className="border-border/60 text-muted-foreground"
        >
          {translate('auto.components.FirstLaunchBanner.fc5cc29955', 'Opt out')}
        </Button>
        <Button size="sm" onClick={handleAcknowledge} disabled={inFlight}>
          {translate('auto.components.FirstLaunchBanner.94cc673726', 'Got it')}
        </Button>
      </div>
      {/* aria-label says "Dismiss" but this persists silent opt-in, not just hides the UI. */}
      <button
        type="button"
        aria-label={translate('auto.components.FirstLaunchBanner.b9e1b966c7', 'Dismiss notice')}
        onClick={handleAcknowledge}
        disabled={inFlight}
        className="absolute right-1.5 top-1.5 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
