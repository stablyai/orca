import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { buildAiVaultSessionId } from '../../shared/ai-vault-session-id'
import { aiVaultScanLimit } from '../../shared/ai-vault-session-depth'
import { sessionSortTime } from './session-scanner-accumulator'

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
            id: buildAiVaultSessionId({
              executionHostId,
              agent: session.agent,
              sessionId: session.sessionId,
              filePath: session.filePath,
              previousId: session.id
            })
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
    scannedAt: new Date().toISOString()
  }
}

export function mergeAiVaultSessions(
  cappedSessions: readonly AiVaultSession[],
  scopeSessions: readonly AiVaultSession[]
): AiVaultSession[] {
  if (scopeSessions.length === 0) {
    return [...cappedSessions]
  }
  const byId = new Map(cappedSessions.map((session) => [session.id, session]))
  for (const session of scopeSessions) {
    byId.set(session.id, session)
  }
  return [...byId.values()].sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
}
