import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../shared/crash-reporting'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from './durable-crash-breadcrumb'
import {
  collectLateSiblingAttributions,
  observeChildProcessDeath,
  SIBLING_DEATH_LOOKBACK_MS,
  trackRendererCrashReport,
  type ChildProcessDeath
} from './process-gone-sibling-correlation'

type AttributionDetails = Record<string, CrashReportDetailValue>

// Observe before suppression: recoverable child deaths can still explain a renderer crash.
export function correlateChildProcessDeath(death: ChildProcessDeath): void {
  observeChildProcessDeath(death)
  for (const { pending, attribution } of collectLateSiblingAttributions(death)) {
    pending.attachAttribution(attribution)
    recordCoalescedDurableCrashBreadcrumb({
      name: 'process_gone_sibling_attribution',
      data: attribution,
      coalesceKey: `${death.reason}:${death.exitCode ?? 'null'}`,
      minIntervalMs: SIBLING_DEATH_LOOKBACK_MS
    })
  }
}

export function trackRendererSiblingAttribution(
  event: Pick<ChildProcessDeath, 'reason' | 'exitCode'> & { source: string },
  at: number,
  siblingDeaths: ChildProcessDeath[],
  attachDetails: (reportId: string, details: AttributionDetails) => Promise<unknown>,
  recorded: Promise<{ id: string }>,
  breadcrumbData: CrashReportBreadcrumbData,
  origin?: string
): void {
  if (event.source !== 'renderer') {
    return
  }
  trackRendererCrashReport(
    {
      at,
      reason: event.reason,
      exitCode: event.exitCode,
      attachAttribution: siblingAttributionAttacher(attachDetails, recorded, breadcrumbData, origin)
    },
    siblingDeaths
  )
}

// Amend late sibling evidence without delaying the initial crash-report write.
export function siblingAttributionAttacher(
  attachDetails: (reportId: string, details: AttributionDetails) => Promise<unknown>,
  recorded: Promise<{ id: string }>,
  breadcrumbData: CrashReportBreadcrumbData,
  origin?: string
): (details: AttributionDetails) => void {
  return (details) => {
    void recorded
      .then((report) =>
        // Surface amendment failures; no other caller observes this promise.
        attachDetails(report.id, details).catch((error) => {
          console.error('[crash-reporting] Failed to attach sibling attribution:', error)
          recordDurableCrashBreadcrumb(
            'sibling_attribution_attach_failed',
            breadcrumbData,
            error instanceof Error ? error.message : String(error),
            origin
          )
        })
      )
      // The recorder already reports a failed initial write.
      .catch(() => {})
  }
}
