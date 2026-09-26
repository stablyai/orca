import {
  sanitizeCrashReportDetails,
  type CrashReportBreadcrumb,
  type CrashReportDetailValue
} from '../../shared/crash-reporting'
import { getCrashBreadcrumbSnapshot } from './crash-breadcrumb-store'

type CrashReportDetails = Record<string, CrashReportDetailValue>

/**
 * How close to the death a breadcrumb has to be before it may be read as part
 * of the story.
 *
 * Why label at all: the ring is emitted in time order with no ages, so its
 * newest entry always sits flush against the death and reads as adjacent to it.
 * On report a8b4e777 that entry was a `self_tree_kill` 1046 s old and two
 * separate investigators concluded Orca had killed its own renderer.
 *
 * Why 60 s: wider than every correlation window this package already trusts
 * (5 s self-kill lookback, 30 s sibling correlation and suppression coalescing),
 * so a crumb marked stale is one no other reader here would have believed
 * either. The mark narrows how a crumb may be read; it never drops one.
 *
 * Two things can overstate an age, and both are survivable because the mark is
 * additive and drops nothing. Ages come from the wall clock (`createdAt` vs
 * `goneAt`) rather than the monotonic clock the store uses for its own
 * suppression windows, so an NTP step or a sleep/resume just before a death can
 * push an adjacent crumb past 60 s; the 5 s and 30 s windows above read the
 * same clock. And a coalesced crumb keeps the `createdAt` of its window start,
 * so its age can overstate by up to that coalesce interval.
 */
export const BREADCRUMB_CAUSAL_WINDOW_MS = 60_000

function breadcrumbAgeMs(breadcrumb: CrashReportBreadcrumb, goneAt: number): number | undefined {
  const createdAt = Date.parse(breadcrumb.createdAt)
  return Number.isFinite(createdAt) ? Math.max(0, goneAt - createdAt) : undefined
}

/** Stamps `outsideCausalWindow` on the crumbs too old to explain `goneAt`. */
export function annotateBreadcrumbCausalProvenance(
  breadcrumbs: CrashReportBreadcrumb[],
  goneAt: number
): CrashReportBreadcrumb[] {
  return breadcrumbs.map((breadcrumb) => {
    const ageMs = breadcrumbAgeMs(breadcrumb, goneAt)
    if (ageMs === undefined || ageMs <= BREADCRUMB_CAUSAL_WINDOW_MS) {
      return breadcrumb
    }
    return { ...breadcrumb, data: { ...breadcrumb.data, ageMs, outsideCausalWindow: true } }
  })
}

/**
 * How old the trail is as a whole. `breadcrumbNewestAgeMs` is the one that
 * settles a8b4e777: a newest crumb older than the causal window means the ring
 * predates the death entirely and explains nothing about it.
 *
 * `breadcrumbCount` counts what the report ships - origin-filtered and capped -
 * not everything that happened.
 */
export function breadcrumbProvenanceDetails(
  breadcrumbs: CrashReportBreadcrumb[],
  goneAt: number
): CrashReportDetails {
  const details: CrashReportDetails = { breadcrumbCount: breadcrumbs.length }
  let newest: { breadcrumb: CrashReportBreadcrumb; ageMs: number } | undefined
  let inWindow = 0
  for (const breadcrumb of breadcrumbs) {
    const ageMs = breadcrumbAgeMs(breadcrumb, goneAt)
    if (ageMs === undefined) {
      continue
    }
    if (ageMs <= BREADCRUMB_CAUSAL_WINDOW_MS) {
      inWindow += 1
    }
    if (!newest || ageMs < newest.ageMs) {
      newest = { breadcrumb, ageMs }
    }
  }
  if (!newest) {
    return details
  }
  details.breadcrumbNewestAgeMs = newest.ageMs
  details.breadcrumbNewestName = newest.breadcrumb.name
  details.breadcrumbsInCausalWindowCount = inWindow
  details.breadcrumbCausalWindowMs = BREADCRUMB_CAUSAL_WINDOW_MS
  return details
}

/** The trail a report ships, with the provenance that keeps it from reading as
 *  a causal chain. `origin` is stripped here: it scopes the snapshot, and no
 *  report carries it. */
export function reportBreadcrumbsWithProvenance(
  reporterOrigin: string | undefined,
  goneAt: number
): { breadcrumbs: CrashReportBreadcrumb[]; details: CrashReportDetails } {
  const breadcrumbs = annotateBreadcrumbCausalProvenance(
    getCrashBreadcrumbSnapshot(reporterOrigin).map(({ origin: _origin, ...crumb }) => crumb),
    goneAt
  )
  return {
    breadcrumbs,
    details: sanitizeCrashReportDetails(breadcrumbProvenanceDetails(breadcrumbs, goneAt))
  }
}
