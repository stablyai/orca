import type { AiVaultScanIssue } from '../../shared/ai-vault-types'
import {
  aiVaultScanIssueText,
  type AiVaultScanIssueText
} from '../../shared/ai-vault-scan-issue-copy'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-error'
import { errorMessage } from './session-scanner-values'

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
      ...(issue.executionHostId ? { executionHostId: issue.executionHostId } : {}),
      agent: issue.agent,
      kind: 'notice',
      path: 'Agent Session History scan',
      ...aiVaultScanIssueText('issuesOmitted')
    })
  }
}

/** A scan failure whose message comes from the coded scan-issue table. */
export class AiVaultScanIssueError extends Error {
  constructor(readonly text: AiVaultScanIssueText) {
    super(text.message)
    this.name = 'AiVaultScanIssueError'
  }
}

/** Issue copy for a caught scan error: coded when Orca authored it, else its verbatim message. */
export function scanIssueTextFromError(error: unknown): AiVaultScanIssueText {
  if (error instanceof AiVaultScanIssueError) {
    return error.text
  }
  if (error instanceof WslTranscriptFsError && error.text) {
    return error.text
  }
  return { message: errorMessage(error) }
}
