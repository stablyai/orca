import type { Store } from '../persistence/loading-store/store'
import { clearFirstLaunchLayoutProp, isTelemetryEnabled, track } from './client'

/**
 * Enqueues the first-launch layout report on the first launch that finds it unrecorded: normally once per install,
 * best effort (enqueueing does not prove receipt, and a crash before the marker is saved can repeat it on a later
 * launch). When telemetry cannot send, the profile is marked skipped: it keeps its layout but its events carry no label.
 */
export function reportFirstLaunchLayout(store: Store): void {
  try {
    const telemetry = store.getSettings().telemetry
    const layout = telemetry?.firstLaunchLayout
    if (!telemetry || !layout || telemetry.firstLaunchLayoutReport !== undefined) {
      return
    }
    const sent =
      isTelemetryEnabled() &&
      track('first_launch_layout_shown', {
        layout,
        fresh_profile: telemetry.protectedMilestones?.installCohort === 'fresh'
      })
    if (!sent) {
      clearFirstLaunchLayoutProp()
    }
    store.updateSettings({
      telemetry: {
        ...telemetry,
        firstLaunchLayoutReport: sent ? 'sent' : 'skipped'
      }
    })
  } catch (err) {
    // Startup must not fail over a report; an unreported profile simply stays out of the comparison.
    console.warn('[telemetry] first launch layout report failed', err)
  }
}
