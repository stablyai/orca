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
  // Persist pre-crash context because native crashes cannot retain memory-only breadcrumbs.
  span.end()
}

// Coalesce error storms so they cannot erase the bounded pre-crash trail (#8260).
const DUPLICATE_TAB_OWNER_BREADCRUMB = 'terminal_tab_id_owned_by_multiple_worktrees'
const PARK_VERDICT_CHURN_BREADCRUMB = 'terminal_park_verdict_churn'
const REACT_COMMIT_CASCADE_BREADCRUMB = 'react_commit_cascade'
const REPLAY_GUARD_WEDGED_BREADCRUMB = 'terminal_replay_guard_wedged_release'
const COALESCED_RENDERER_BREADCRUMB_NAMES = new Set([
  'renderer_error',
  'renderer_unhandled_rejection',
  'terminal_safe_fit_retry_exhausted',
  DUPLICATE_TAB_OWNER_BREADCRUMB,
  PARK_VERDICT_CHURN_BREADCRUMB,
  REACT_COMMIT_CASCADE_BREADCRUMB,
  REPLAY_GUARD_WEDGED_BREADCRUMB,
  TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB
])
const RENDERER_BREADCRUMB_COALESCE_MS = 30_000
// Hidden panes exhaust retries together; retain multiplicity in one slot via suppressedSinceLast.
const NAME_ONLY_COALESCED_BREADCRUMB_NAMES = new Set(['terminal_safe_fit_retry_exhausted'])
// Coalesce the scarce ring while preserving every bounded-rate event in durable spans.
const PER_EVENT_TRACED_COALESCED_BREADCRUMB_NAMES = new Set([REPLAY_GUARD_WEDGED_BREADCRUMB])

function rendererBreadcrumbCoalesceKey(
  name: string,
  data: CrashReportBreadcrumbData | undefined
): string | undefined {
  if (NAME_ONLY_COALESCED_BREADCRUMB_NAMES.has(name)) {
    return name
  }
  // Identity-field presence distinguishes restore and reattach call sites; bound to four slots per storm.
  if (name === REPLAY_GUARD_WEDGED_BREADCRUMB) {
    return `${name}:${data?.ptyId ? 'pty' : ''}:${data?.tabIdHash ? 'tab' : ''}`
  }
  // Preserve near-crash burst evidence separately from benign window churn.
  if (name === PARK_VERDICT_CHURN_BREADCRUMB) {
    return `${name}:${String(data?.trigger ?? '')}`
  }
  // Preserve independent surfaces, drivers and driverless cascades instead of last-write collapse.
  if (name === REACT_COMMIT_CASCADE_BREADCRUMB) {
    return `${name}:${String(data?.rendererSurface ?? '')}:${String(data?.driverFrame ?? '')}`
  }
  // Preserve distinct GPU failures and atlas-reset triggers while coalescing each storm.
  if (name === TERMINAL_WEBGL_DIAGNOSTIC_BREADCRUMB) {
    const kind = String(data?.kind ?? '')
    const reason = kind === 'webgl-atlas-reset' ? data?.reason : undefined
    return reason ? `${name}:${kind}:${String(reason)}` : `${name}:${kind}`
  }
  // Bound per-tab storms without collapsing opposing convergence verdicts.
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
  // Message-less failures lack stable identity; do not collapse unrelated crash evidence.
  if (!message) {
    return undefined
  }

  // Include sanitized source identity so common error text cannot collapse unrelated failures.
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
  // Reuse equal-field keys instead of serializing the same message/stack throughout a storm.
  if (
    lastCoalesceKey !== null &&
    lastCoalesceName === name &&
    lastCoalesceMessage === message &&
    arraysShallowEqual(lastCoalesceSource, sourceIdentity)
  ) {
    return lastCoalesceKey
  }
  const key = JSON.stringify([name, message, ...sourceIdentity])
  lastCoalesceName = name
  lastCoalesceMessage = message
  lastCoalesceSource = sourceIdentity
  lastCoalesceKey = key
  return key
}

let lastCoalesceName: string | null = null
let lastCoalesceMessage: string | undefined
let lastCoalesceSource: unknown[] | null = null
let lastCoalesceKey: string | null = null

function arraysShallowEqual(a: unknown[] | null, b: unknown[]): boolean {
  if (!a || a.length !== b.length) {
    return false
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false
    }
  }
  return true
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
    if (PER_EVENT_TRACED_COALESCED_BREADCRUMB_NAMES.has(args.name)) {
      // Per-event spans already count multiplicity; do not add the ring's running total.
      recordRendererBreadcrumbTrace(args.name, data)
    } else if (coalesceResult) {
      // Avoid per-duplicate serialization and disk churn after coalescing.
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
