import os from 'node:os'
import { app } from 'electron'
import type {
  ReactErrorBoundaryReportArgs,
  ReactErrorBoundaryReportResult
} from '../../shared/crash-reporting'
import {
  CRASH_REPORT_ATTRIBUTION_DETAIL_KEY,
  CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY,
  UNRELIABLE_BOUNDARY_ATTRIBUTION,
  UNRELIABLE_BOUNDARY_ATTRIBUTION_NOTE
} from '../../shared/react-update-depth-attribution'
import type { CrashReportStore } from '../crash-reporting/crash-report-store'
import { rendererCrashBreadcrumbOrigin } from '../../shared/crash-breadcrumb-origin'
import { getCrashBreadcrumbSnapshot } from '../crash-reporting/crash-breadcrumb-store'

export const recentRendererErrorReportKeys = new Map<string, number>()

const RENDERER_ERROR_DEDUPE_MS = 10 * 60 * 1000
const MAX_RENDERER_ERROR_KEY_AGE_MS = RENDERER_ERROR_DEDUPE_MS * 2
const MAX_RECENT_RENDERER_ERROR_REPORT_KEYS = 256

const REACT_ERROR_BOUNDARY_SURFACES = new Set<ReactErrorBoundaryReportArgs['surface']>([
  'app-root',
  'web-root',
  'workspace-shell',
  'sidebar',
  'terminal-workbench',
  'right-sidebar',
  'page',
  'modal',
  'overlay',
  'rich-markdown-editor',
  'dashboard-popout'
])

function stringField(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') {
    return undefined
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return undefined
  }
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function nullableStringField(value: unknown, maxLength: number): string | null | undefined {
  if (value === null) {
    return null
  }
  return stringField(value, maxLength)
}

function attributionField(value: unknown): ReactErrorBoundaryReportArgs['attribution'] {
  // Only the one known verdict; anything else from a newer renderer degrades to no attribution.
  return value === UNRELIABLE_BOUNDARY_ATTRIBUTION ? UNRELIABLE_BOUNDARY_ATTRIBUTION : undefined
}

function normalizeRendererErrorReportArgs(args: unknown): ReactErrorBoundaryReportArgs | null {
  if (!args || typeof args !== 'object') {
    return null
  }
  const record = args as Record<string, unknown>
  const attribution = attributionField(record.attribution)
  const boundaryId = stringField(record.boundaryId, 120)
  const surface = stringField(record.surface, 80)
  const errorName = stringField(record.errorName, 120) ?? 'Error'
  const errorMessage = stringField(record.errorMessage, 1_000) ?? 'Unknown render error'
  if (
    !boundaryId ||
    !surface ||
    !REACT_ERROR_BOUNDARY_SURFACES.has(surface as ReactErrorBoundaryReportArgs['surface'])
  ) {
    return null
  }

  return {
    boundaryId,
    surface: surface as ReactErrorBoundaryReportArgs['surface'],
    errorName,
    errorMessage,
    ...(stringField(record.errorStack, 8_000)
      ? { errorStack: stringField(record.errorStack, 8_000) }
      : {}),
    ...(stringField(record.componentStack, 8_000)
      ? { componentStack: stringField(record.componentStack, 8_000) }
      : {}),
    ...(stringField(record.activeView, 80)
      ? { activeView: stringField(record.activeView, 80) }
      : {}),
    ...(nullableStringField(record.activeModal, 80) !== undefined
      ? { activeModal: nullableStringField(record.activeModal, 80) ?? null }
      : {}),
    ...(stringField(record.activeTabType, 80)
      ? { activeTabType: stringField(record.activeTabType, 80) }
      : {}),
    ...(stringField(record.activeRightSidebarTab, 80)
      ? { activeRightSidebarTab: stringField(record.activeRightSidebarTab, 80) }
      : {}),
    ...(typeof record.hasActiveWorktree === 'boolean'
      ? { hasActiveWorktree: record.hasActiveWorktree }
      : {}),
    ...(attribution ? { attribution } : {})
  }
}

function pruneRendererErrorReportKeys(now: number): void {
  for (const [key, seenAt] of recentRendererErrorReportKeys) {
    if (now - seenAt > MAX_RENDERER_ERROR_KEY_AGE_MS) {
      recentRendererErrorReportKeys.delete(key)
    }
  }
  while (recentRendererErrorReportKeys.size > MAX_RECENT_RENDERER_ERROR_REPORT_KEYS) {
    const oldestKey = recentRendererErrorReportKeys.keys().next().value
    if (oldestKey === undefined) {
      break
    }
    recentRendererErrorReportKeys.delete(oldestKey)
  }
}

function getRendererErrorReportKey(
  args: ReactErrorBoundaryReportArgs,
  webContentsId?: number
): string {
  return JSON.stringify({
    webContentsId,
    boundaryId: args.boundaryId,
    surface: args.surface,
    errorName: args.errorName,
    errorMessage: args.errorMessage,
    componentStack: args.componentStack
  }).slice(0, 12_000)
}

export async function recordRendererErrorReport(
  store: CrashReportStore,
  args: unknown,
  webContentsId?: number
): Promise<ReactErrorBoundaryReportResult> {
  const normalized = normalizeRendererErrorReportArgs(args)
  if (!normalized) {
    return { ok: false, error: 'Invalid renderer error report.' }
  }

  const now = Date.now()
  pruneRendererErrorReportKeys(now)
  const key = getRendererErrorReportKey(normalized, webContentsId)
  if (now - (recentRendererErrorReportKeys.get(key) ?? 0) < RENDERER_ERROR_DEDUPE_MS) {
    return { ok: true, report: null, deduped: true }
  }
  recentRendererErrorReportKeys.set(key, now)
  // Why: renderer error reports are IPC input. A broken renderer can vary the
  // component stack/message inside the age window, so bound the main-side
  // dedupe map by count as well as time.
  pruneRendererErrorReportKeys(now)

  const report = await store.record({
    source: 'renderer',
    processType: 'react-render',
    reason: 'react-error-boundary',
    exitCode: null,
    appVersion: app.getVersion(),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    electronVersion: process.versions.electron ?? 'unknown',
    chromeVersion: process.versions.chrome ?? 'unknown',
    details: {
      boundary_id: normalized.boundaryId,
      surface: normalized.surface,
      error_name: normalized.errorName,
      error_message: normalized.errorMessage,
      ...(normalized.errorStack ? { error_stack: normalized.errorStack } : {}),
      ...(normalized.componentStack ? { component_stack: normalized.componentStack } : {}),
      ...(normalized.attribution
        ? {
            [CRASH_REPORT_ATTRIBUTION_DETAIL_KEY]: normalized.attribution,
            [CRASH_REPORT_ATTRIBUTION_NOTE_DETAIL_KEY]: UNRELIABLE_BOUNDARY_ATTRIBUTION_NOTE
          }
        : {}),
      ...(normalized.activeView ? { active_view: normalized.activeView } : {}),
      ...(normalized.activeModal !== undefined ? { active_modal: normalized.activeModal } : {}),
      ...(normalized.activeTabType ? { active_tab_type: normalized.activeTabType } : {}),
      ...(normalized.activeRightSidebarTab
        ? { right_sidebar_tab: normalized.activeRightSidebarTab }
        : {}),
      ...(normalized.hasActiveWorktree !== undefined
        ? { has_active_worktree: normalized.hasActiveWorktree }
        : {})
    },
    // Why: React render failures are recoverable only because a boundary
    // caught them; persist the same recent app breadcrumbs as native crashes.
    breadcrumbs: getCrashBreadcrumbSnapshot(
      webContentsId === undefined ? undefined : rendererCrashBreadcrumbOrigin(webContentsId)
    )
  })

  return { ok: true, report, deduped: false }
}
