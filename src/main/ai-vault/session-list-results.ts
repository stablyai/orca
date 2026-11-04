import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { AiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import { sessionSortTime } from './session-scanner-accumulator'
import {
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult
} from '../../shared/ai-vault-session-depth'

export function aiVaultScanIssueResult({
  executionHostId,
  path,
  ...text
}: {
  executionHostId?: ExecutionHostId
  path: string
} & AiVaultScanIssueText): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        ...(executionHostId ? { executionHostId } : {}),
        agent: 'codex',
        kind: 'host',
        path,
        ...text
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

// Cancelled scans keep the existing list instead of repainting with this empty body.
export function cancelledAiVaultListResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: new Date().toISOString(), cancelled: true }
}

// Restamp the shared host-local cache for runtime callers, preserving the scanner's session-ID recipe.
export function restampAiVaultListResult(
  result: AiVaultListResult,
  executionHostId: ExecutionHostId
): AiVaultListResult {
  return {
    sessions: result.sessions.map((session) =>
      session.executionHostId === executionHostId
        ? session
        : {
            ...session,
            executionHostId,
            id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
          }
    ),
    issues: result.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: result.scannedAt
  }
}

export function mergeAiVaultListResults(
  results: readonly AiVaultListResult[],
  rawLimit: number | undefined,
  unlimited = false,
  scopePaths: readonly string[] = []
): AiVaultListResult {
  const depth = requestedAiVaultSessionDepth({ limit: rawLimit, unlimited })
  const byId = new Map<string, AiVaultSession>()
  const issues: AiVaultScanIssue[] = []
  for (const result of results) {
    for (const session of result.sessions) {
      byId.set(session.id, session)
    }
    issues.push(...result.issues)
  }
  return truncateAiVaultListResult(
    {
      sessions: [...byId.values()].sort(
        (left, right) => sessionSortTime(right) - sessionSortTime(left)
      ),
      issues,
      // Reuse accepted scan times so unchanged host results cannot fabricate freshness.
      scannedAt: latestAiVaultScannedAt(results)
    },
    depth,
    scopePaths
  )
}

function latestAiVaultScannedAt(results: readonly AiVaultListResult[]): string {
  const nowMs = Date.now()
  let latestMs = Number.NEGATIVE_INFINITY
  for (const result of results) {
    const stampMs = Date.parse(result.scannedAt)
    // Reject invalid or future remote clocks; compare instants because ISO spellings can sort differently.
    if (Number.isNaN(stampMs) || stampMs > nowMs) {
      continue
    }
    latestMs = Math.max(latestMs, stampMs)
  }
  // Canonicalize equal instants so host enumeration order cannot change the merged stamp.
  return new Date(latestMs === Number.NEGATIVE_INFINITY ? nowMs : latestMs).toISOString()
}
