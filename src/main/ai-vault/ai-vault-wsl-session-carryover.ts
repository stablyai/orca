import type { AiVaultListResult, AiVaultSession } from '../../shared/ai-vault-types'
import { aiVaultScanIssueText } from '../../shared/ai-vault-scan-issue-copy'
import { isWslUncPath } from '../../shared/wsl-paths'

// The WSL rows of the last scan whose WSL roots a confirmed running list named, per scope key.
// Map order is recency: the oldest scope is evicted past the cap, so retired scopes don't pile up.
const lastConfirmedWslSessions = new Map<string, AiVaultSession[]>()

/** Scopes kept: the active one plus a few recently switched away from, for switching back. */
export const AI_VAULT_WSL_CARRYOVER_SCOPE_LIMIT = 4

function rememberConfirmedWslSessions(scopeKey: string, sessions: AiVaultSession[]): void {
  lastConfirmedWslSessions.delete(scopeKey)
  // A confirmed scan with no WSL rows has nothing to carry; don't spend a slot on it.
  if (sessions.length === 0) {
    return
  }
  lastConfirmedWslSessions.set(scopeKey, sessions)
  for (const oldest of lastConfirmedWslSessions.keys()) {
    if (lastConfirmedWslSessions.size <= AI_VAULT_WSL_CARRYOVER_SCOPE_LIMIT) {
      break
    }
    lastConfirmedWslSessions.delete(oldest)
  }
}

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
    rememberConfirmedWslSessions(scopeKey, result.sessions.filter(isWslSession))
    return result
  }
  const confirmed = lastConfirmedWslSessions.get(scopeKey)
  if (confirmed) {
    // Carrying a scope over is using it: keep the active scope ahead of retired ones.
    rememberConfirmedWslSessions(scopeKey, confirmed)
  }
  const present = new Set(result.sessions.map((session) => session.id))
  const carried = (confirmed ?? []).filter((session) => !present.has(session.id))
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
