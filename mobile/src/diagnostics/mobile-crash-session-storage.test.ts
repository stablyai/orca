import { describe, expect, it } from 'vitest'
import type { CrashReportBreadcrumb } from '../../../src/shared/crash-reporting'
import {
  MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS,
  parseMobileCrashJournal,
  serializeMobileCrashJournal,
  type PersistedMobileCrashJournal
} from './mobile-crash-session-storage'

const OPENED_AT = '2026-08-24T18:00:00.000Z'

function makeLargeBreadcrumbs(
  prefix: string,
  count: number,
  payloadChars = 3_900
): CrashReportBreadcrumb[] {
  return Array.from({ length: count }, (_, index) => ({
    createdAt: OPENED_AT,
    name: 'render_error_contained',
    data: { errorStack: `${prefix}-${index}-${'x'.repeat(payloadChars)}` }
  }))
}

function makeJournal(
  activeBreadcrumbs: CrashReportBreadcrumb[],
  previousBreadcrumbs?: CrashReportBreadcrumb[]
): PersistedMobileCrashJournal {
  return {
    version: 1,
    activeSession: {
      openedAt: OPENED_AT,
      marker: 'open',
      breadcrumbs: activeBreadcrumbs
    },
    ...(previousBreadcrumbs
      ? {
          latestAbnormalSession: {
            openedAt: OPENED_AT,
            breadcrumbs: previousBreadcrumbs,
            endedAbnormally: true
          }
        }
      : {})
  }
}

describe('mobile crash session storage', () => {
  it('caps a journal whose breadcrumb ring exceeds the payload budget', () => {
    const serialized = serializeMobileCrashJournal(makeJournal(makeLargeBreadcrumbs('active', 30)))

    expect(serialized.length).toBeLessThanOrEqual(MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS)
  })

  it('caps oversized breadcrumb arrays when reading persisted data', () => {
    const raw = JSON.stringify(makeJournal(makeLargeBreadcrumbs('active', 40, 20)))
    const parsed = parseMobileCrashJournal(raw)

    expect(parsed?.activeSession.breadcrumbs).toHaveLength(30)
    expect(parsed?.activeSession.breadcrumbs[0]?.data?.errorStack).toContain('active-10-')
  })

  it('evicts current breadcrumbs before previous abnormal-session evidence', () => {
    const serialized = serializeMobileCrashJournal(
      makeJournal(makeLargeBreadcrumbs('active', 12), makeLargeBreadcrumbs('previous', 12))
    )
    const parsed = parseMobileCrashJournal(serialized)

    expect(parsed?.latestAbnormalSession?.breadcrumbs.length).toBeGreaterThan(
      parsed?.activeSession.breadcrumbs.length ?? 0
    )
  })

  it('preserves all seven previous crash breadcrumbs before trimming the live session', () => {
    const serialized = serializeMobileCrashJournal(
      makeJournal(
        makeLargeBreadcrumbs('active', 7, 2_800),
        makeLargeBreadcrumbs('previous', 7, 2_800)
      )
    )
    const parsed = parseMobileCrashJournal(serialized)

    expect(parsed?.latestAbnormalSession?.breadcrumbs).toHaveLength(7)
    expect(parsed?.activeSession.breadcrumbs.length).toBeLessThan(7)
  })
})
