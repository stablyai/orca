import type { CrashReportDetailValue } from '../../shared/crash-reporting'

/**
 * Correlates `child-process-gone` with `render-process-gone`.
 *
 * Why: Electron delivers one event per dead process with no causal link between
 * them, so a renderer that only died because a sibling utility died is
 * indistinguishable from a genuine renderer crash while each event is
 * classified alone. The correlation is attached as evidence, never used to drop
 * a report — see #14667.
 */

// Why: a child that died before the renderer can plausibly have taken it with it,
// so look back across the widest same-incident spread in the 1.4.184 batch (600ms,
// whole-tree kills) with headroom.
export const SIBLING_DEATH_LOOKBACK_MS = 1_000
// Why: the forward direction is not the mirror of the backward one. A child dying
// after the renderer is at least as likely to be an effect of it — Chromium tearing
// down the dead renderer's service channels, or our own renderer_recovery_reload at
// +264ms — so only the observed collateral spread (+180ms, GPU) is admitted.
export const SIBLING_DEATH_LOOKAHEAD_MS = 250

// Why: timing alone is not a verdict. The observed collateral pairs are tight
// (-21ms, -2ms, +180ms), while a child looping at the observed 1459/min drops a
// death into every window on that host. A correlation is asserted only for a
// tight, non-repeating sibling; otherwise the offsets ship as bare evidence.
const SIBLING_ATTRIBUTION_PROXIMITY_MS = 250

// Why: names the evidence (these processes died together) and not a cause. The
// largest 1.4.184 cluster is an external taskkill /T where renderer and children
// are co-victims — no sibling killed anything, and a consumer filtering on this
// key must not read one.
const CONCURRENT_PROCESS_DEATHS = 'concurrent-process-deaths'

// Why: one incident produces a handful of events; a deeper ring would only let
// a pre-existing child crash loop outlive the window.
const MAX_TRACKED_CHILD_DEATHS = 16
// Per-renderer dedupe allows concurrent reports from many webContents.
const MAX_PENDING_RENDERER_REPORTS = 16

// Why: sanitizeCrashReportDetails caps a generic detail at 240 chars and would cut
// the list mid-token; drop whole entries instead and say how many were dropped.
const MAX_SIBLING_DEATHS_DETAIL_LENGTH = 200

// Why: a child crash-looping at 1459/min would otherwise rewrite the persisted
// record on every event, during the window in which the renderer is recovering.
// Two attaches cover the observed shape (one late GPU death) plus its successor.
const MAX_LATE_SIBLING_ATTACHES = 2

// Why: `crashed` and `abnormal-exit` are one failure class split by which Chromium
// callback reported it, and a collateral pair routinely arrives as one of each.
const ABNORMAL_DEATH_REASONS = new Set(['crashed', 'abnormal-exit'])

export type ChildProcessDeath = {
  at: number
  processType: string
  serviceName?: string
  reason: string
  exitCode: number | null
}

export type PendingRendererCrashReport = {
  at: number
  reason: string
  exitCode: number | null
  attachAttribution: (details: Record<string, CrashReportDetailValue>) => void
}

type TrackedRendererCrashReport = PendingRendererCrashReport & {
  siblingDeaths: ChildProcessDeath[]
  lateAttaches: number
}

export type LateSiblingAttribution = {
  pending: PendingRendererCrashReport
  attribution: Record<string, CrashReportDetailValue>
}

let childDeaths: ChildProcessDeath[] = []
let pendingRendererReports: TrackedRendererCrashReport[] = []

function isSiblingOfRendererDeath(childAt: number, rendererAt: number): boolean {
  const offsetMs = childAt - rendererAt
  return offsetMs >= -SIBLING_DEATH_LOOKBACK_MS && offsetMs <= SIBLING_DEATH_LOOKAHEAD_MS
}

function crashReasonClass(reason: string): string {
  return ABNORMAL_DEATH_REASONS.has(reason) ? 'abnormal' : reason
}

// Why: win32 gives every process in a collateral pair the identical crashed/-1, so
// the exit code discriminates there. POSIX surfaces a per-process wait status
// instead (renderer SIGSEGV vs utility SIGKILL), so gating on equality would mean
// this never fires on macOS/Linux — there the code only corroborates.
function hasMatchingFailureSignature(
  death: ChildProcessDeath,
  reason: string,
  exitCode: number | null
): boolean {
  if (crashReasonClass(death.reason) !== crashReasonClass(reason)) {
    return false
  }
  return process.platform !== 'win32' || death.exitCode === exitCode
}

export function observeChildProcessDeath(death: ChildProcessDeath): void {
  childDeaths.push(death)
  if (childDeaths.length > MAX_TRACKED_CHILD_DEATHS) {
    childDeaths = childDeaths.slice(-MAX_TRACKED_CHILD_DEATHS)
  }
}

/** Child deaths sharing the renderer's failure signature inside the window. */
export function findSiblingChildDeaths({
  reason,
  exitCode,
  at
}: {
  reason: string
  exitCode: number | null
  at: number
}): ChildProcessDeath[] {
  return childDeaths.filter(
    (death) =>
      hasMatchingFailureSignature(death, reason, exitCode) && isSiblingOfRendererDeath(death.at, at)
  )
}

export function trackRendererCrashReport(
  pending: PendingRendererCrashReport,
  siblingDeaths: ChildProcessDeath[] = []
): void {
  const liveReports = pendingRendererReports
    .filter((report) => pending.at - report.at <= SIBLING_DEATH_LOOKAHEAD_MS)
    .slice(-(MAX_PENDING_RENDERER_REPORTS - 1))
  pendingRendererReports = [
    ...liveReports,
    { ...pending, siblingDeaths: [...siblingDeaths], lateAttaches: 0 }
  ]
}

function childIdentity(death: ChildProcessDeath): string {
  // Electron repeats the type as the service name for the GPU process.
  return death.serviceName && death.serviceName !== death.processType
    ? `${death.processType}/${death.serviceName}`
    : death.processType
}

function describeChildDeath(death: ChildProcessDeath, rendererAt: number): string {
  const offsetMs = death.at - rendererAt
  return `${childIdentity(death)} ${offsetMs >= 0 ? '+' : ''}${offsetMs}ms`
}

/** Signed offsets are the point: they let triage separate one collateral
 *  incident from a host where a child is crash-looping into every window. */
function describeSiblingDeaths(siblings: ChildProcessDeath[], rendererAt: number): string {
  const described = [...siblings]
    .sort((a, b) => Math.abs(a.at - rendererAt) - Math.abs(b.at - rendererAt))
    .map((death) => describeChildDeath(death, rendererAt))
  const kept: string[] = []
  for (const entry of described) {
    if (kept.length > 0 && [...kept, entry].join(', ').length > MAX_SIBLING_DEATHS_DETAIL_LENGTH) {
      break
    }
    kept.push(entry)
  }
  const dropped = described.length - kept.length
  return dropped > 0 ? `${kept.join(', ')} (+${dropped} more)` : kept.join(', ')
}

function repeatedIdentityCount(siblings: ChildProcessDeath[]): number {
  return siblings.length - new Set(siblings.map(childIdentity)).size
}

function isOneIncident(siblings: ChildProcessDeath[], rendererAt: number): boolean {
  if (siblings.length === 0 || repeatedIdentityCount(siblings) > 0) {
    return false
  }
  return siblings.some(
    (death) => Math.abs(death.at - rendererAt) <= SIBLING_ATTRIBUTION_PROXIMITY_MS
  )
}

export function siblingProcessDeathDetails(
  siblings: ChildProcessDeath[],
  rendererAt: number
): Record<string, CrashReportDetailValue> {
  const repeats = repeatedIdentityCount(siblings)
  return {
    ...(isOneIncident(siblings, rendererAt) ? { crashAttribution: CONCURRENT_PROCESS_DEATHS } : {}),
    siblingProcessDeathCount: siblings.length,
    ...(repeats > 0 ? { siblingProcessDeathRepeats: repeats } : {}),
    siblingProcessDeaths: describeSiblingDeaths(siblings, rendererAt)
  }
}

/**
 * Renderer reports already on disk that this later child death now explains,
 * each with its full sibling set.
 */
export function collectLateSiblingAttributions(death: ChildProcessDeath): LateSiblingAttribution[] {
  pendingRendererReports = pendingRendererReports.filter((report) =>
    isSiblingOfRendererDeath(death.at, report.at)
  )
  const attributions: LateSiblingAttribution[] = []
  for (const pending of pendingRendererReports) {
    if (
      pending.lateAttaches >= MAX_LATE_SIBLING_ATTACHES ||
      !hasMatchingFailureSignature(death, pending.reason, pending.exitCode)
    ) {
      continue
    }
    pending.siblingDeaths.push(death)
    pending.lateAttaches += 1
    attributions.push({
      pending,
      attribution: siblingProcessDeathDetails(pending.siblingDeaths, pending.at)
    })
  }
  return attributions
}

export function resetProcessGoneSiblingCorrelationForTest(): void {
  childDeaths = []
  pendingRendererReports = []
}
