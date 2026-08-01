import {
  shouldKeepProvisionalGpuFallbackMarker,
  type GpuFallbackEngagementOutcome
} from './gpu-fallback-engagement'

/**
 * Bookkeeping that must follow an `engageGpuFallback` outcome.
 *
 * Why its own module: this lived inline in index.ts, where the only coverage was
 * source-text matching. A mutation that kept the provisional path on *every*
 * outcome — which deletes the consented marker on the way out and brings the app
 * back on the same broken GPU — passed the entire suite.
 */
export type GpuFallbackEngagementResolution = {
  /** userData path the shutdown drop must keep retrying, or null to stand down. */
  provisionalMarkerPath: string | null
  /** Rewrite the marker with consent recorded, because the user answered "restart". */
  rePersistConsentedMarker: boolean
  /** Drop the cross-launch crash count, because this engagement settled it. */
  clearDurableHistory: boolean
  /** Relaunch into safe graphics now. */
  relaunch: boolean
}

export function resolveGpuFallbackEngagement(
  outcome: GpuFallbackEngagementOutcome,
  userDataPath: string
): GpuFallbackEngagementResolution {
  return {
    provisionalMarkerPath: shouldKeepProvisionalGpuFallbackMarker(outcome) ? userDataPath : null,
    // Why both outcomes: the pre-prompt persist recorded consented:false, and a
    // session-end drop can take the marker while the prompt is still open.
    rePersistConsentedMarker: outcome === 'restart' || outcome === 'confirmed-quitting',
    // Why every outcome but 'marker-failed': a declined prompt must not re-fire on
    // the very next GPU crash, and a consented one is about to relaunch. Only
    // 'marker-failed' never prompted at all, so its count stays armed to retry a
    // write that failed transiently rather than demanding three fresh crashes.
    clearDurableHistory: outcome !== 'marker-failed',
    relaunch: outcome === 'restart'
  }
}
