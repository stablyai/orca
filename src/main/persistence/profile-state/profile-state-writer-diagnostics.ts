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

// Only codes, counters, and timings: never payloads, paths, or profile ids.
function errorFields(error: unknown): CrashReportBreadcrumbData {
  const code =
    error instanceof Error && 'code' in error && typeof error.code === 'string'
      ? error.code
      : 'unknown'
  return { errorCode: code, outcome: profileStateWriterFailureOutcome(error) }
}

export type ProfileStateWriterSlowPhase = 'awaiting-reply' | 'awaiting-exit'

/** Elapsed is monotonic time without an observed completion, not CPU time. */
export function recordProfileStateWriterSlow(
  request: ProfileStateWriterDiagnosticRequest & {
    phase: ProfileStateWriterSlowPhase
    elapsedMs: number
  }
): void {
  // Coalesced: one stall can leave consecutive requests slow in a single burst.
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
