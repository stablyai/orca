import {
  sanitizeCrashReportBreadcrumbs,
  sanitizeCrashReportString,
  type CrashReportBreadcrumb,
  type CrashReportBreadcrumbData
} from '../../../src/shared/crash-reporting'
import { describeCrashError } from '../../../src/shared/crash-error-description'
import {
  MAX_STORED_MOBILE_CRASH_BREADCRUMBS,
  MOBILE_CRASH_SESSION_STORAGE_KEY,
  parseMobileCrashJournal,
  serializeMobileCrashJournal,
  snapshotMobileCrashSession,
  type MobileCrashSessionSnapshot,
  type MobileCrashStorage,
  type PersistedMobileCrashJournal,
  type PersistedMobileCrashSession
} from './mobile-crash-session-storage'

export {
  MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS,
  MOBILE_CRASH_SESSION_STORAGE_KEY,
  type MobileCrashSessionSnapshot,
  type MobileCrashStorage
} from './mobile-crash-session-storage'

type JournalOptions = {
  now?: () => number
}

const SAFE_ROUTE_SEGMENTS = new Set([
  'about',
  'accounts',
  'agent-history',
  'browser-settings',
  'connection-log',
  'edit',
  'files',
  'h',
  'history',
  'index',
  'mobile-onboarding',
  'native-chat-settings',
  'notification-opt-in',
  'notifications',
  'pair',
  'pair-confirm',
  'pair-scan',
  'pr',
  'preview',
  'review',
  'session',
  'settings',
  'source-control',
  'tasks',
  'terminal-settings',
  'troubleshoot',
  'voice-settings',
  '[hostId]',
  '[worktreeId]'
])

export class MobileCrashSessionJournal {
  private readonly storage: MobileCrashStorage
  private readonly now: () => number
  private queue: Promise<void> = Promise.resolve()
  private startPromise: Promise<MobileCrashSessionSnapshot | null> | null = null
  private journal: PersistedMobileCrashJournal | null = null

  constructor(storage: MobileCrashStorage, options: JournalOptions = {}) {
    this.storage = storage
    this.now = options.now ?? Date.now
  }

  start(): Promise<MobileCrashSessionSnapshot | null> {
    if (this.startPromise) {
      return this.startPromise
    }
    this.startPromise = this.enqueue(async () => {
      const stored = await this.readJournal()
      const abnormal =
        stored &&
        (stored.activeSession.marker === 'open' ||
          stored.activeSession.breadcrumbs.some(
            (breadcrumb) => breadcrumb.name === 'render_error_contained'
          ))
          ? snapshotMobileCrashSession(stored.activeSession)
          : null
      const openedAt = new Date(this.now()).toISOString()
      const activeSession: PersistedMobileCrashSession = {
        openedAt,
        marker: 'open',
        breadcrumbs: [createBreadcrumb(openedAt, 'session_started')]
      }
      this.journal = {
        version: 1,
        activeSession,
        ...(abnormal || stored?.latestAbnormalSession
          ? { latestAbnormalSession: abnormal ?? stored?.latestAbnormalSession }
          : {}),
        ...(stored?.dismissedAbnormalSessionOpenedAt
          ? { dismissedAbnormalSessionOpenedAt: stored.dismissedAbnormalSessionOpenedAt }
          : {})
      }
      await this.persistJournal()
      return abnormal
    })
    return this.startPromise
  }

  async recordRoute(segments: readonly string[]): Promise<void> {
    await this.start()
    await this.enqueue(async () => {
      this.appendBreadcrumb('route_changed', { route: formatRouteTemplate(segments) })
      await this.persistJournal()
    })
  }

  async recordAppState(state: string): Promise<void> {
    await this.start()
    await this.enqueue(async () => {
      const safeState = normalizeAppState(state)
      if (safeState === 'active' && this.journal) {
        this.journal.activeSession.marker = 'open'
      }
      this.appendBreadcrumb('app_state_changed', { state: safeState })
      if (safeState === 'background' && this.journal) {
        this.journal.activeSession.marker = 'closed'
      }
      await this.persistJournal()
    })
  }

  async recordRenderError(error: unknown, componentStack?: string | null): Promise<void> {
    await this.start()
    await this.enqueue(async () => {
      this.appendBreadcrumb('render_error_contained', describeCrashError(error, componentStack))
      await this.persistJournal()
    })
  }

  async getLatestAbnormalSession(): Promise<MobileCrashSessionSnapshot | null> {
    await this.start()
    return this.enqueue(async () => this.journal?.latestAbnormalSession ?? null)
  }

  async getUndismissedLatestAbnormalSession(): Promise<MobileCrashSessionSnapshot | null> {
    await this.start()
    return this.enqueue(async () => {
      const latest = this.journal?.latestAbnormalSession
      return latest?.openedAt === this.journal?.dismissedAbnormalSessionOpenedAt
        ? null
        : (latest ?? null)
    })
  }

  async dismissLatestAbnormalSession(openedAt: string): Promise<void> {
    await this.start()
    await this.enqueue(async () => {
      if (!this.journal || this.journal.latestAbnormalSession?.openedAt !== openedAt) {
        return
      }
      this.journal.dismissedAbnormalSessionOpenedAt = openedAt
      await this.persistJournal()
    })
  }

  async buildReport(app: { version: string; platform: string }): Promise<string> {
    await this.start()
    return this.enqueue(async () => {
      const lines = [
        'Orca Mobile crash diagnostics',
        `Generated: ${new Date(this.now()).toISOString()}`,
        `App: Orca Mobile ${sanitizeCrashReportString(app.version)} · ${sanitizeCrashReportString(app.platform)}`
      ]
      const previous = this.journal?.latestAbnormalSession
      if (previous) {
        lines.push('', previousSessionTitle(previous.endedAbnormally))
        appendSessionLines(lines, previous)
      } else {
        lines.push('', 'No previous abnormal session recorded.')
      }
      if (this.journal) {
        lines.push('', 'Current session')
        appendSessionLines(lines, this.journal.activeSession)
      }
      return lines.join('\n')
    })
  }

  private appendBreadcrumb(name: string, data?: CrashReportBreadcrumbData): void {
    if (!this.journal) {
      return
    }
    this.journal.activeSession.breadcrumbs.push(
      createBreadcrumb(new Date(this.now()).toISOString(), name, data)
    )
    this.journal.activeSession.breadcrumbs = this.journal.activeSession.breadcrumbs.slice(
      -MAX_STORED_MOBILE_CRASH_BREADCRUMBS
    )
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation)
    this.queue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async readJournal(): Promise<PersistedMobileCrashJournal | null> {
    try {
      const raw = await this.storage.getItem(MOBILE_CRASH_SESSION_STORAGE_KEY)
      return raw ? parseMobileCrashJournal(raw) : null
    } catch {
      return null
    }
  }

  private async persistJournal(): Promise<void> {
    if (!this.journal) {
      return
    }
    try {
      await this.storage.setItem(
        MOBILE_CRASH_SESSION_STORAGE_KEY,
        serializeMobileCrashJournal(this.journal)
      )
    } catch {
      // Crash evidence is best-effort and must never create a second app failure.
    }
  }
}

export function previousSessionTitle(endedAbnormally: boolean): string {
  return endedAbnormally
    ? 'Previous session ended abnormally'
    : 'Previous session recovered from a render error'
}

function createBreadcrumb(
  createdAt: string,
  name: string,
  data?: CrashReportBreadcrumbData
): CrashReportBreadcrumb {
  return (
    sanitizeCrashReportBreadcrumbs([{ createdAt, name, data }])?.[0] ?? {
      createdAt,
      name
    }
  )
}

function formatRouteTemplate(segments: readonly string[]): string {
  if (segments.length === 0) {
    return 'index'
  }
  return segments
    .map((segment) => (SAFE_ROUTE_SEGMENTS.has(segment) ? segment : '[dynamic]'))
    .join(' > ')
}

function normalizeAppState(state: string): string {
  return ['active', 'background', 'inactive', 'unknown', 'extension'].includes(state)
    ? state
    : 'unknown'
}

function appendSessionLines(
  lines: string[],
  session: Pick<MobileCrashSessionSnapshot, 'openedAt' | 'breadcrumbs'>
): void {
  lines.push(`Opened: ${session.openedAt}`)
  lines.push(`Breadcrumbs (${session.breadcrumbs.length}, oldest first):`)
  for (const breadcrumb of session.breadcrumbs) {
    const data = breadcrumb.data ? ` ${JSON.stringify(breadcrumb.data)}` : ''
    lines.push(`${breadcrumb.createdAt} ${breadcrumb.name}${data}`)
  }
}
