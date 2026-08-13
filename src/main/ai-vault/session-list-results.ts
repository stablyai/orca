import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { sessionSortTime } from './session-scanner-accumulator'
import { aiVaultScanLimit } from '../../shared/ai-vault-session-depth'

export function aiVaultScanIssueResult(args: {
  executionHostId?: ExecutionHostId
  path: string
  message: string
}): AiVaultListResult {
  return {
    sessions: [],
    issues: [
      {
        ...(args.executionHostId ? { executionHostId: args.executionHostId } : {}),
        agent: 'codex',
        kind: 'host',
        path: args.path,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

// A superseded scan has no findings to report; the flag tells the renderer to
// keep the list it already has rather than paint this empty body.
export function cancelledAiVaultListResult(): AiVaultListResult {
  return { sessions: [], issues: [], scannedAt: new Date().toISOString(), cancelled: true }
}

// Why: the serving-side scan is host-local and cached once for every caller
// (desktop parent, web, mobile), so callers that address this host by a runtime
// id get the cached result restamped on the way out instead of a per-host scan.
// Mirrors the scanner's stamp recipe so ids stay stable across both paths.
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
  unlimited = false
): AiVaultListResult {
  const limit = aiVaultScanLimit({ limit: rawLimit, unlimited })
  const byId = new Map<string, AiVaultSession>()
  const issues: AiVaultScanIssue[] = []
  for (const result of results) {
    for (const session of result.sessions) {
      byId.set(session.id, session)
    }
    issues.push(...result.issues)
  }
  return {
    sessions: [...byId.values()]
      .sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
      .slice(0, limit),
    issues,
    // Why: a merge is not a new scan. Reminting here made every all-host cache
    // hit look fresh to the renderer, which only skipped apply when scannedAt
    // matched. Keep the latest input stamp so identical legs stay a no-op.
    scannedAt: latestAiVaultScannedAt(results)
  }
}

function latestAiVaultScannedAt(results: readonly AiVaultListResult[]): string {
  const nowMs = Date.now()
  let latest: string | undefined
  let latestMs = Number.NEGATIVE_INFINITY
  for (const result of results) {
    const stamp = result.scannedAt
    const stampMs = Date.parse(stamp)
    // Remote legs carry their own clock and only `z.string()` validation. An
    // unparsable or future stamp would pin the merged stamp above every local
    // rescan and silently freeze the renderer's scannedAt equality guard.
    // Compare parsed instants, not strings: `z.string()` does not pin the stamp
    // to the exact `toISOString()` shape, and a legal variant (no milliseconds,
    // a `+00:00` offset) orders wrongly under lexicographic compare.
    if (Number.isNaN(stampMs) || stampMs > nowMs) {
      continue
    }
    if (stampMs > latestMs) {
      latestMs = stampMs
      latest = stamp
    }
  }
  return latest ?? new Date(nowMs).toISOString()
}
