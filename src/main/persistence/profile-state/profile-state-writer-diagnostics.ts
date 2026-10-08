import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../../crash-reporting/durable-crash-breadcrumb'
import { getSystemPowerState } from '../../system-power-lifecycle'
import type { ProfileStateWriterDeadlineExpiry } from './profile-state-writer-deadline'
import { profileStateWriterFailureOutcome } from './profile-state-writer-errors'

export type ProfileStateWriterDiagnosticRequest = {
  command: string
  requestId: number
  acknowledgedRevision: number
}

// Only codes, counters, and timings: never payloads, paths, or profile ids.
function errorFields(error: unknown): CrashReportBreadcrumbData {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown'
  return { errorCode: code, outcome: profileStateWriterFailureOutcome(error) }
}

function expiryFields(expiry: ProfileStateWriterDeadlineExpiry): CrashReportBreadcrumbData {
  return {
    timeoutMs: expiry.timeoutMs,
    elapsedMs: Math.round(expiry.elapsedMs),
    overdueMs: Math.round(expiry.overdueMs),
    graces: expiry.graces,
    powerState: expiry.powerState
  }
}

export function recordProfileStateWriterGrace(
  request: ProfileStateWriterDiagnosticRequest,
  expiry: ProfileStateWriterDeadlineExpiry
): void {
  // Coalesced: a long stall can grant grace to consecutive requests in one burst.
  recordCoalescedDurableCrashBreadcrumb({
    name: 'profile_state_writer_deadline_grace',
    data: { ...request, ...expiryFields(expiry) },
    coalesceKey: 'profile_state_writer_deadline_grace',
    minIntervalMs: 60_000
  })
}

export function recordProfileStateWriterTimeout(
  request: ProfileStateWriterDiagnosticRequest,
  expiry: ProfileStateWriterDeadlineExpiry
): void {
  recordDurableCrashBreadcrumb('profile_state_writer_timeout', {
    ...request,
    ...expiryFields(expiry)
  })
}

export function recordProfileStateWriterFault(
  error: unknown,
  active: { command: string; id: number } | undefined,
  acknowledgedRevision: number,
  exitCode?: number
): void {
  const fields = errorFields(error)
  // Timeouts already carry their deadline timings in profile_state_writer_timeout.
  if (fields.errorCode === 'profile-state-writer-timeout') {
    return
  }
  recordDurableCrashBreadcrumb('profile_state_writer_failed', {
    ...fields,
    ...(active && { command: active.command, requestId: active.id }),
    acknowledgedRevision,
    ...(exitCode === undefined ? {} : { exitCode }),
    powerState: getSystemPowerState()
  })
}

export function recordProfileStateWriteFailureReport(
  error: unknown,
  presentation: 'dialog' | 'deferred' | 'suppressed' | 'duplicate'
): void {
  recordDurableCrashBreadcrumb('profile_state_write_failure_reported', {
    ...errorFields(error),
    presentation
  })
}
