import type {
  AiVaultListResult,
  AiVaultScanIssue,
  AiVaultSession
} from '../../shared/ai-vault-types'
import type { ExecutionHostId } from '../../shared/execution-host'
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
        path: args.path,
        message: args.message
      }
    ],
    scannedAt: new Date().toISOString()
  }
}

export function mergeAiVaultListResults(
  results: readonly AiVaultListResult[],
  rawLimit: number | undefined
): AiVaultListResult {
  const limit = rawLimit && rawLimit > 0 ? Math.floor(rawLimit) : 1000
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
