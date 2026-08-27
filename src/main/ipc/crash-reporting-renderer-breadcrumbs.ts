import {
  type CrashReportBreadcrumbData,
  sanitizeCrashReportDetails,
  sanitizeCrashReportString
} from '../../shared/crash-reporting'
import {
  recordCoalescedCrashBreadcrumb,
  recordCrashBreadcrumb
} from '../crash-reporting/crash-breadcrumb-store'
import { startSpan } from '../observability/tracer'
import { TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB } from '../../shared/terminal-webgl-diagnostics'

function sanitizeRendererBreadcrumbData(value: unknown): CrashReportBreadcrumbData | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const primitiveData: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' || typeof entry === 'boolean' || entry === null) {
      primitiveData[key] = entry
    } else if (typeof entry === 'number' && Number.isFinite(entry)) {
      primitiveData[key] = entry
    }
  }
  const sanitized = sanitizeCrashReportDetails(primitiveData)
  return Object.keys(sanitized).length > 0 ? sanitized : undefined
}

function recordRendererBreadcrumbTrace(
  name: string,
  data: CrashReportBreadcrumbData | undefined
): void {
  const span = startSpan('renderer.breadcrumb', {
    attributes: {
      kind: 'crash-breadcrumb',
      'breadcrumb.name': sanitizeCrashReportString(name),
      ...(data ? { 'breadcrumb.data': data } : {})
    }
  })
  // Why: main-process native crashes cannot persist memory-only breadcrumbs.
  // A tiny trace span gives the next crash report durable pre-crash context.
  span.end()
}

// Why: a repeating renderer error (e.g. a ResizeObserver or SSH-rejection
// storm, #8260) can flush the whole fixed-size breadcrumb ring in seconds,
// erasing the pre-crash trail. Coalesce repeats into one entry that carries a
// suppressed count instead.
const DUPLICATE_TAB_OWNER_BREADCRUMB = 'terminal_tab_id_owned_by_multiple_worktrees'
const PARK_VERDICT_CHURN_BREADCRUMB = 'terminal_park_verdict_churn'
const COALESCED_RENDERER_BREADCRUMB_NAMES = new Set([
  'renderer_error',
  'renderer_unhandled_rejection',
  'terminal_safe_fit_retry_exhausted',
  DUPLICATE_TAB_OWNER_BREADCRUMB,
  PARK_VERDICT_CHURN_BREADCRUMB,
  TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB
])
const RENDERER_BREADCRUMB_COALESCE_MS = 30_000
// Why: these carry no message identity — they are per-tab telemetry whose rate,
// not whose text, is the signal. Coalescing by name alone bounds a many-tab
// storm to one ring entry plus a suppressed count.
//
// terminal_safe_fit_retry_exhausted: every hidden (display:none) pane is 0x0 and
// burns its whole retry budget, so one post-reload reattach wave fires once per
// mounted pane within ~60ms. Windows crash F0BKR84AHEH lost 26-90% of its
// 30-entry ring to two such bursts. `suppressedSinceLast` keeps the pane count
// — the only signal these carry — in one slot.
const NAME_ONLY_COALESCED_BREADCRUMB_NAMES = new Set(['terminal_safe_fit_retry_exhausted'])

function rendererBreadcrumbCoalesceKey(
  name: string,
  data: CrashReportBreadcrumbData | undefined
): string | undefined {
  if (NAME_ONLY_COALESCED_BREADCRUMB_NAMES.has(name)) {
    return name
  }
  // Why trigger and not name alone: `burst` means damping engaged a commit
  // short of React #185, `window` means slow benign churn. Collapsing them
  // would drop the near-crash signal into a slow-churn slot. Still bounded —
  // two slots per storm regardless of tab count.
  if (name === PARK_VERDICT_CHURN_BREADCRUMB) {
    return `${name}:${String(data?.trigger ?? '')}`
  }
  // Preserve distinct GPU failures and atlas-reset triggers while coalescing each storm.
  if (name === TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB) {
    const kind = String(data?.kind ?? '')
    const reason = kind === 'webgl-atlas-reset' ? data?.reason : undefined
    return reason ? `${name}:${kind}:${String(reason)}` : `${name}:${kind}`
  }
  // Why: a stale map can emit once per tab-id/verdict; key by verdict so
  // last-write coalescing cannot erase the other signal while remaining bounded.
  if (name === DUPLICATE_TAB_OWNER_BREADCRUMB) {
    return `${name}:${String(data?.resolvedToActiveWorktree ?? '')}`
  }
  const primaryMessage = name === 'renderer_error' ? data?.message : data?.reasonMessage
  const fallbackMessage = name === 'renderer_error' ? data?.errorMessage : undefined
  const message =
    typeof primaryMessage === 'string' && primaryMessage.length > 0
      ? primaryMessage
      : typeof fallbackMessage === 'string' && fallbackMessage.length > 0
        ? fallbackMessage
        : undefined
  // Why: message-less failures have no stable identity, so grouping them could
  // erase unrelated crash evidence. Sanitization already caps messages at 240 chars.
  if (!message) {
    return undefined
  }

  // Why: common messages such as "Script error" or "Cannot read properties"
  // can come from unrelated sites. Include sanitized source evidence so one
  // failure cannot suppress the breadcrumb for another.
  const sourceIdentity =
    name === 'renderer_error'
      ? [
          data?.errorStack,
          data?.filename,
          data?.lineno,
          data?.colno,
          data?.errorType,
          data?.errorName,
          data?.errorMessage
        ]
      : [data?.reasonStack, data?.reasonType, data?.reasonName]
  return JSON.stringify([name, message, ...sourceIdentity])
}

export function recordRendererBreadcrumbFromRenderer(
  args?: { name?: unknown; data?: unknown },
  origin?: string
): void {
  if (!args || typeof args.name !== 'string') {
    return
  }
  const data = sanitizeRendererBreadcrumbData(args.data)
  if (COALESCED_RENDERER_BREADCRUMB_NAMES.has(args.name)) {
    const coalesceKey = rendererBreadcrumbCoalesceKey(args.name, data)
    if (!coalesceKey) {
      if (origin) {
        recordCrashBreadcrumb(args.name, data, origin)
      } else {
        recordCrashBreadcrumb(args.name, data)
      }
      recordRendererBreadcrumbTrace(args.name, data)
      return
    }
    const coalesceResult = recordCoalescedCrashBreadcrumb({
      name: args.name,
      data,
      coalesceKey: origin ? `${origin}\u0000${coalesceKey}` : coalesceKey,
      minIntervalMs: RENDERER_BREADCRUMB_COALESCE_MS,
      ...(origin ? { origin } : {})
    })
    // Why: tracing every suppressed duplicate would preserve the same
    // serialization and disk churn that breadcrumb coalescing removes.
    if (coalesceResult) {
      recordRendererBreadcrumbTrace(
        args.name,
        coalesceResult.suppressedSinceLast > 0
          ? { ...data, suppressedSinceLast: coalesceResult.suppressedSinceLast }
          : data
      )
    }
  } else {
    if (origin) {
      recordCrashBreadcrumb(args.name, data, origin)
    } else {
      recordCrashBreadcrumb(args.name, data)
    }
    recordRendererBreadcrumbTrace(args.name, data)
  }
}
