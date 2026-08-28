import {
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportString,
  type CrashReportBreadcrumb
} from '../../../src/shared/crash-reporting'

export type MobileCrashStorage = {
  getItem: (key: string) => Promise<string | null>
  setItem: (key: string, value: string) => Promise<void>
}

export type MobileCrashSessionSnapshot = {
  openedAt: string
  breadcrumbs: CrashReportBreadcrumb[]
  endedAbnormally: boolean
}

export type PersistedMobileCrashSession = Omit<MobileCrashSessionSnapshot, 'endedAbnormally'> & {
  marker: 'open' | 'closed'
}

export type PersistedMobileCrashJournal = {
  version: 1
  activeSession: PersistedMobileCrashSession
  latestAbnormalSession?: MobileCrashSessionSnapshot
  dismissedAbnormalSessionOpenedAt?: string
}

export const MOBILE_CRASH_SESSION_STORAGE_KEY = 'orca.mobile-crash-session.v1'
export const MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS = 24_000
export const MAX_STORED_MOBILE_CRASH_BREADCRUMBS = 30

export function snapshotMobileCrashSession(
  session: PersistedMobileCrashSession
): MobileCrashSessionSnapshot {
  return {
    openedAt: session.openedAt,
    endedAbnormally: session.marker === 'open',
    breadcrumbs: session.breadcrumbs.map((breadcrumb) => ({
      ...breadcrumb,
      ...(breadcrumb.data ? { data: { ...breadcrumb.data } } : {})
    }))
  }
}

export function parseMobileCrashJournal(raw: string): PersistedMobileCrashJournal | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed.version !== 1) {
      return null
    }
    const activeSession = parseSession(parsed.activeSession)
    if (!activeSession) {
      return null
    }
    const latestAbnormalSession = parseSnapshot(parsed.latestAbnormalSession)
    const dismissedAbnormalSessionOpenedAt =
      typeof parsed.dismissedAbnormalSessionOpenedAt === 'string'
        ? sanitizeCrashReportString(parsed.dismissedAbnormalSessionOpenedAt, 80)
        : null
    return {
      version: 1,
      activeSession,
      ...(latestAbnormalSession ? { latestAbnormalSession } : {}),
      ...(dismissedAbnormalSessionOpenedAt ? { dismissedAbnormalSessionOpenedAt } : {})
    }
  } catch {
    return null
  }
}

export function serializeMobileCrashJournal(journal: PersistedMobileCrashJournal): string {
  const bounded: PersistedMobileCrashJournal = {
    version: 1,
    activeSession: {
      ...journal.activeSession,
      breadcrumbs: [...journal.activeSession.breadcrumbs]
    },
    ...(journal.latestAbnormalSession
      ? {
          latestAbnormalSession: {
            ...journal.latestAbnormalSession,
            breadcrumbs: [...journal.latestAbnormalSession.breadcrumbs]
          }
        }
      : {}),
    ...(journal.dismissedAbnormalSessionOpenedAt
      ? { dismissedAbnormalSessionOpenedAt: journal.dismissedAbnormalSessionOpenedAt }
      : {})
  }
  let serialized = JSON.stringify(bounded)
  while (serialized.length > MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS) {
    const previous = bounded.latestAbnormalSession?.breadcrumbs
    const active = bounded.activeSession.breadcrumbs
    if (active.length > 1) {
      active.shift()
    } else if (previous && previous.length > 1) {
      previous.shift()
    } else {
      break
    }
    serialized = JSON.stringify(bounded)
  }
  return serialized
}

function parseSession(value: unknown): PersistedMobileCrashSession | null {
  const candidate = value as Record<string, unknown> | null
  const session = parseSessionData(value)
  if (!candidate || !session || (candidate.marker !== 'open' && candidate.marker !== 'closed')) {
    return null
  }
  return {
    ...session,
    marker: candidate.marker
  }
}

function parseSnapshot(value: unknown): MobileCrashSessionSnapshot | null {
  const candidate = value as Record<string, unknown> | null
  const session = parseSessionData(value)
  if (!candidate || !session) {
    return null
  }
  const endedAbnormally =
    typeof candidate.endedAbnormally === 'boolean'
      ? candidate.endedAbnormally
      : !session.breadcrumbs.some((breadcrumb) => breadcrumb.name === 'render_error_contained')
  return { ...session, endedAbnormally }
}

function parseSessionData(
  value: unknown
): Omit<MobileCrashSessionSnapshot, 'endedAbnormally'> | null {
  if (!value || typeof value !== 'object') {
    return null
  }
  const candidate = value as Record<string, unknown>
  if (typeof candidate.openedAt !== 'string' || !Array.isArray(candidate.breadcrumbs)) {
    return null
  }
  const recentBreadcrumbs = (candidate.breadcrumbs as CrashReportBreadcrumb[]).slice(
    -MAX_STORED_MOBILE_CRASH_BREADCRUMBS
  )
  const breadcrumbs = recentBreadcrumbs.flatMap(
    (breadcrumb) => sanitizeCrashReportBreadcrumbs([breadcrumb]) ?? []
  )
  return {
    openedAt: sanitizeCrashReportString(candidate.openedAt, 80),
    breadcrumbs
  }
}
