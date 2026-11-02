import type { CrashReportDetailValue } from '../../shared/crash-reporting'

// Correlation is timing evidence only; never use it to discard a renderer crash report.

// Cover the observed 600 ms tree-kill spread with headroom.
export const SIBLING_DEATH_LOOKBACK_MS = 1_000
// Later child deaths may be renderer teardown effects, so use a shorter forward window.
export const SIBLING_DEATH_LOOKAHEAD_MS = 250

// Attribute only tight, non-repeating sibling deaths; loops remain bare timing evidence.
const SIBLING_ATTRIBUTION_PROXIMITY_MS = 250

// Concurrent deaths may share an external cause; this label must not imply causality.
const CONCURRENT_PROCESS_DEATHS = 'concurrent-process-deaths'

const MAX_TRACKED_CHILD_DEATHS = 16
const MAX_PENDING_RENDERER_REPORTS = 16

// Drop whole entries before the generic detail cap can cut a token in half.
const MAX_SIBLING_DEATHS_DETAIL_LENGTH = 200

// Bound persisted amendments so a child crash loop cannot repeatedly rewrite the report.
const MAX_LATE_SIBLING_ATTACHES = 2

// Chromium callbacks may label the same incident crashed or abnormal-exit.
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

// Require matching Windows exit codes; POSIX siblings may have different per-process wait statuses.
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

// Signed offsets distinguish collateral incidents from children looping through every window.
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

/** Return late sibling evidence with each pending renderer report's full sibling set. */
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
