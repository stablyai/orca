import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

const REMOTE_SCAN_ISSUE_LIMIT = 500

export function recordRemoteSessionScanIssue(
  issues: AiVaultScanIssue[],
  issue: AiVaultScanIssue
): void {
  if (issues.length < REMOTE_SCAN_ISSUE_LIMIT - 1) {
    issues.push(issue)
    return
  }
  if (issues.length === REMOTE_SCAN_ISSUE_LIMIT - 1) {
    // Kinded: this row is a scan notice, not a skipped transcript — the panel
    // counts unkinded issues as skipped transcript files.
    issues.push({
      executionHostId: issue.executionHostId,
      agent: issue.agent,
      kind: 'notice',
      path: 'Agent Session History scan',
      message: 'Additional scan issues were omitted.'
    })
  }
}
