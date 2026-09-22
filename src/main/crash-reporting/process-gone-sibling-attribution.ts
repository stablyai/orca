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

// Why: the sibling ring has to see the child deaths that classification throws
// away as recoverable churn — those are precisely the ones that explain a
// renderer death, so observing runs before any suppression decision.
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

/**
 * Folds a sibling death that arrived late into the report already on disk.
 *
 * Why an amend: the report is persisted immediately rather than deferred behind a
 * settle timer (#14667), so a sibling that dies after it cannot be folded into the
 * original write.
 */
export function siblingAttributionAttacher(
  attachDetails: (reportId: string, details: AttributionDetails) => Promise<unknown>,
  recorded: Promise<{ id: string }>,
  breadcrumbData: CrashReportBreadcrumbData,
  origin?: string
): (details: AttributionDetails) => void {
  return (details) => {
    void recorded
      .then((report) =>
        // Why: nothing else observes this amend, so a failed write would otherwise
        // drop the attribution with no trace of why.
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
      // A rejected record is already reported by the recorder's persist chain.
      .catch(() => {})
  }
}
