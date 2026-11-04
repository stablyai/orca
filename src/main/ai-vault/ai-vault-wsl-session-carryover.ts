import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import { isWslUncPath } from '../../shared/wsl-paths'

// The WSL rows of the last scan whose WSL roots a confirmed running list named, per scope key.
const lastConfirmedWslSessions = new Map<string, AiVaultSession[]>()

const isWslSession = (session: AiVaultSession): boolean => isWslUncPath(session.filePath)

/**
 * A failed running-list probe says nothing about WSL: keep the last confirmed WSL rows, marked
 * partial, rather than letting every WSL session vanish until the probe recovers.
 */
export function carryOverUnconfirmedWslSessions(
  scopeKey: string,
  result: AiVaultListResult,
  wslConfirmed: boolean
): AiVaultListResult {
  if (wslConfirmed) {
    lastConfirmedWslSessions.set(scopeKey, result.sessions.filter(isWslSession))
    return result
  }
  const present = new Set(result.sessions.map((session) => session.id))
  const carried = (lastConfirmedWslSessions.get(scopeKey) ?? []).filter(
    (session) => !present.has(session.id)
  )
  if (carried.length === 0) {
    return result
  }
  return {
    ...result,
    sessions: [...result.sessions, ...carried].sort((a, b) =>
      b.modifiedAt.localeCompare(a.modifiedAt)
    ),
    issues: [
      ...result.issues,
      {
        agent: carried[0]?.agent ?? 'codex',
        kind: 'notice',
        path: '',
        ...aiVaultScanIssueText('wslSessionsFromLastScan')
      }
    ]
  }
}

export function resetAiVaultWslSessionCarryover(): void {
  lastConfirmedWslSessions.clear()
}
