import type { CrashReportBreadcrumbData } from '../../../shared/crash-reporting'
import {
  recordCoalescedDurableCrashBreadcrumb,
  recordDurableCrashBreadcrumb
} from '../../crash-reporting/durable-crash-breadcrumb'
import { getSystemPowerState } from '../../system-power-lifecycle'
import { profileStateWriterFailureOutcome } from './profile-state-writer-errors'

export type ProfileStateWriterDiagnosticRequest = {
  command: string
  requestId: number
  acknowledgedRevision: number
}

// Exclude payloads, paths and profile IDs from diagnostic fields.
function errorFields(error: unknown): CrashReportBreadcrumbData {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown'
  return { errorCode: code, outcome: profileStateWriterFailureOutcome(error) }
}

export type ProfileStateWriterSlowPhase = 'awaiting-reply' | 'awaiting-exit'

/** Monotonic wait duration, including stalled loops, rather than CPU time. */
export function recordProfileStateWriterSlow(
  request: ProfileStateWriterDiagnosticRequest & {
    phase: ProfileStateWriterSlowPhase
    elapsedMs: number
  }
): void {
  // Coalesce consecutive slow requests from one stall.
  recordCoalescedDurableCrashBreadcrumb({
    name: 'profile_state_writer_slow',
    data: request,
    coalesceKey: 'profile_state_writer_slow',
    minIntervalMs: 60_000
  })
}

export function recordProfileStateWriterFault(
  error: unknown,
  active: { command: string; id: number } | undefined,
  acknowledgedRevision: number,
  exitCode?: number
): void {
  recordDurableCrashBreadcrumb('profile_state_writer_failed', {
    ...errorFields(error),
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
