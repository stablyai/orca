import type { ClaudeManagedAccountSummary } from '../../shared/managed-account-types'
import type { ClaudeProfileSetupReport } from './claude-profile-setup'

type ClaudeProfileSetupIssue = NonNullable<ClaudeManagedAccountSummary['profileSetupIssue']>

// Why in memory: every setup re-derives it, so a restart or the next setup replaces it.
const issues = new Map<string, ClaudeProfileSetupIssue>()

/** Logs a setup's warnings and keeps the one an account row should mention. */
export function recordClaudeProfileSetupReport(
  accountId: string,
  report: Pick<ClaudeProfileSetupReport, 'warnings'>
): void {
  if (report.warnings.length > 0) {
    console.warn(
      '[claude-profile] Profile setup finished with warnings:',
      accountId,
      report.warnings
    )
  }
  const issue = report.warnings.some((warning) => warning.surface === 'hooks')
    ? 'hooks'
    : report.warnings.some((warning) => warning.code !== 'cross-filesystem')
      ? 'links'
      : report.warnings.length > 0
        ? 'private-history'
        : null
  if (issue) {
    issues.set(accountId, issue)
  } else {
    issues.delete(accountId)
  }
}

export function getClaudeProfileSetupIssue(accountId: string): ClaudeProfileSetupIssue | undefined {
  return issues.get(accountId)
}
