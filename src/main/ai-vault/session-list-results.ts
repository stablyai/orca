import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { sessionSortTime } from './session-scanner-accumulator'
import { boundAiVaultListResult } from './session-list-retention'

export function aiVaultScanIssueResult(args: {
  executionHostId?: ExecutionHostId
  path: string
  message: string
}): AiVaultListResult {
  return boundAiVaultListResult({
    sessions: [],
    issues: [
      {
        ...(args.executionHostId ? { executionHostId: args.executionHostId } : {}),
        agent: 'codex',
        path: args.path,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  })
}

// Why: the serving-side scan is host-local and cached once for every caller
// (desktop parent, web, mobile), so callers that address this host by a runtime
// id get the cached result restamped on the way out instead of a per-host scan.
// Mirrors the scanner's stamp recipe so ids stay stable across both paths.
export function restampAiVaultListResult(
  result: AiVaultListResult,
  executionHostId: ExecutionHostId
): AiVaultListResult {
  const retained = boundAiVaultListResult(result)
  return boundAiVaultListResult({
    sessions: retained.sessions.map((session) =>
      session.executionHostId === executionHostId
        ? session
        : {
            ...session,
            executionHostId,
            id: `${executionHostId}:${session.agent}:${session.sessionId}:${session.filePath}`
          }
    ),
    issues: retained.issues.map((issue) => ({ ...issue, executionHostId })),
    scannedAt: retained.scannedAt
  })
}

export function mergeAiVaultListResults(
  results: readonly AiVaultListResult[],
  rawLimit: number | undefined
): AiVaultListResult {
  const limit = rawLimit && rawLimit > 0 ? Math.floor(rawLimit) : 1000
  let merged: AiVaultListResult = { sessions: [], issues: [], scannedAt: new Date().toISOString() }
  for (let index = 0; index < results.length; index += 1) {
    const rawResult = results[index]
    const result = boundAiVaultListResult(rawResult)
    const byId = new Map<string, AiVaultSession>()
    for (const session of [...merged.sessions, ...result.sessions]) {
      byId.set(session.id, session)
    }
    const sessions = [...byId.values()].sort(
      (left, right) => sessionSortTime(right) - sessionSortTime(left)
    )
    merged = boundAiVaultListResult({
      sessions: index === results.length - 1 ? sessions.slice(0, limit) : sessions,
      issues: [...merged.issues, ...result.issues],
      scannedAt: new Date().toISOString()
    })
  }
  return merged
}
