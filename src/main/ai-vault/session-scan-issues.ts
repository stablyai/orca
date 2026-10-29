import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

// Bound IPC payloads when an unreachable host produces one issue per transcript.
export const SCAN_ISSUE_LIMIT = 500

export function recordSessionScanIssue(issues: AiVaultScanIssue[], issue: AiVaultScanIssue): void {
  if (issues.length < SCAN_ISSUE_LIMIT - 1) {
    issues.push(issue)
    return
  }
  if (issues.length === SCAN_ISSUE_LIMIT - 1) {
    // Mark overflow as a notice, preserving host provenance without shadowing scanner defaults.
    issues.push({
      ...issue,
      kind: 'notice',
      path: 'Agent Session History scan',
      message: 'Additional scan issues were omitted.'
    })
  }
}
