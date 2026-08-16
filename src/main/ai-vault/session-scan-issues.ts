import type { AiVaultScanIssue } from '../../shared/ai-vault-types'

// Why: a stalled WSL distro or an unreachable remote host fails one probe per
// discovered path, so an uncapped list ships one row per transcript file in the
// tree over IPC. Local and remote scans share the bound — the failure shape is
// the same and both feed the same panel.
const SCAN_ISSUE_LIMIT = 500

/** Append a scan issue, collapsing everything past the cap into one notice. */
export function recordSessionScanIssue(issues: AiVaultScanIssue[], issue: AiVaultScanIssue): void {
  if (issues.length < SCAN_ISSUE_LIMIT - 1) {
    issues.push(issue)
    return
  }
  if (issues.length === SCAN_ISSUE_LIMIT - 1) {
    // Kinded: this row is a scan notice, not a skipped transcript — the panel
    // counts unkinded issues as skipped transcript files. Spread first so a
    // remote issue keeps its executionHostId and a local one never gains an
    // explicit `undefined` (which would outrank the scanner's own stamping).
    issues.push({
      ...issue,
      kind: 'notice',
      path: 'Agent Session History scan',
      message: 'Additional scan issues were omitted.'
    })
  }
}
