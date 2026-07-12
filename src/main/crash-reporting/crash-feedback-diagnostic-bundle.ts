import os from 'node:os'
import { app } from 'electron'
import {
  sanitizeCrashReportString,
  type CrashReportDiagnosticBundle
} from '../../shared/crash-reporting'
import { collectDiagnosticBundle, getDiagnosticsStatus } from '../observability'
import { resolveDiagnosticOrcaChannel } from '../observability/diagnostic-upload-endpoint'
import type { FeedbackDiagnosticBundleAttachment, FeedbackSubmitResult } from '../ipc/feedback'

const CRASH_REPORT_LOG_LOOKBACK_MINUTES = 3 * 24 * 60

export type CrashDiagnosticBundleAttachment = {
  readonly diagnosticBundle: CrashReportDiagnosticBundle
  readonly feedbackDiagnosticBundle?: FeedbackDiagnosticBundleAttachment
}

function formatUnknownError(error: unknown): string {
  return sanitizeCrashReportString(error instanceof Error ? error.message : String(error))
}

function skippedCrashDiagnosticBundle(): CrashDiagnosticBundleAttachment {
  return {
    diagnosticBundle: {
      status: 'not_uploaded',
      reason: 'diagnostic log upload skipped by user'
    }
  }
}

function collectCrashDiagnosticBundleAttachment(): CrashDiagnosticBundleAttachment {
  const status = getDiagnosticsStatus()
  if (!status.bundleEnabled) {
    return {
      diagnosticBundle: {
        status: 'not_uploaded',
        reason: status.disabledReason ?? 'diagnostic bundle collection is disabled'
      }
    }
  }

  let bundle: ReturnType<typeof collectDiagnosticBundle>
  try {
    bundle = collectDiagnosticBundle({
      appVersion: app.getVersion(),
      platform: os.platform(),
      arch: os.arch(),
      osRelease: os.release(),
      orcaChannel: resolveDiagnosticOrcaChannel(),
      // Why: Help > Report Crash is often used after relaunch, long after the
      // default 30 minute support bundle window would miss the failure context.
      lookbackMinutes: CRASH_REPORT_LOG_LOOKBACK_MINUTES
    })
  } catch (error) {
    return { diagnosticBundle: { status: 'not_uploaded', reason: formatUnknownError(error) } }
  }

  return {
    diagnosticBundle: {
      status: 'attached',
      bundleSubmissionId: bundle.bundleSubmissionId,
      bytes: bundle.bytes,
      spanCount: bundle.spanCount
    },
    feedbackDiagnosticBundle: {
      bundleSubmissionId: bundle.bundleSubmissionId,
      content: bundle.payload,
      bytes: bundle.bytes,
      spanCount: bundle.spanCount
    }
  }
}

export function prepareCrashDiagnosticBundle(
  includeDiagnosticLogs: boolean
): CrashDiagnosticBundleAttachment {
  return includeDiagnosticLogs
    ? collectCrashDiagnosticBundleAttachment()
    : skippedCrashDiagnosticBundle()
}

export function diagnosticBundleForReportOnlyRetry(
  attachment: CrashDiagnosticBundleAttachment
): CrashReportDiagnosticBundle | undefined {
  const bundle = attachment.feedbackDiagnosticBundle
  if (!bundle) {
    return undefined
  }
  return {
    status: 'not_uploaded',
    reason: 'diagnostic log attachment could not be sent; report retried without logs',
    bundleSubmissionId: bundle.bundleSubmissionId,
    bytes: bundle.bytes,
    spanCount: bundle.spanCount
  }
}

export function resolveSubmittedDiagnosticBundle(
  attachment: CrashDiagnosticBundleAttachment,
  result: FeedbackSubmitResult
): CrashReportDiagnosticBundle {
  const bundle = attachment.feedbackDiagnosticBundle
  if (!bundle) {
    return attachment.diagnosticBundle
  }
  const failure =
    result.diagnosticBundleFailure ??
    (!result.ok ? { status: result.status, error: result.error } : undefined)
  if (!failure) {
    return attachment.diagnosticBundle
  }
  return {
    status: 'not_uploaded',
    reason: `diagnostic log attachment failed: ${formatUnknownError(failure.error)}`,
    bundleSubmissionId: bundle.bundleSubmissionId,
    bytes: bundle.bytes,
    spanCount: bundle.spanCount
  }
}
