import type { AiVaultScanIssue, AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { RpcClient } from '../transport/rpc-client'
import { agentHistorySessionScan } from './mobile-agent-history-operations'

// Match desktop SESSION_LIMIT=500 for recency only; host separately caps in-scope union.
export const MOBILE_AI_VAULT_SESSION_LIMIT = 500

export type AgentHistoryScreenState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      sessions: AiVaultSession[]
      issues: AiVaultScanIssue[]
    }

export type FetchedHistoryState =
  | Exclude<AgentHistoryScreenState, { kind: 'ready' }>
  | (Extract<AgentHistoryScreenState, { kind: 'ready' }> & { hostId: string; client: RpcClient })

export type AgentHistoryCachedSnapshot = {
  fingerprint: string
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
}

export type ScanMobileAgentSessionsParams = {
  scopePaths: string[] | undefined
  force: boolean
  previous?: AgentHistoryCachedSnapshot | null
}

export type ScanMobileAgentSessionsResult = {
  sessions: AiVaultSession[]
  issues: AiVaultScanIssue[]
  fingerprint?: string
}

export async function scanMobileAgentSessions(
  client: RpcClient,
  params: ScanMobileAgentSessionsParams
): Promise<ScanMobileAgentSessionsResult> {
  const previousFingerprint = !params.force ? params.previous?.fingerprint : undefined
  const reply = await agentHistorySessionScan.request(client, {
    limit: MOBILE_AI_VAULT_SESSION_LIMIT,
    force: params.force,
    scopePaths: params.scopePaths,
    ...(previousFingerprint ? { afterFingerprint: previousFingerprint } : {})
  })

  const result = agentHistorySessionScan.interpret(reply)
  if (result.unchanged === true) {
    if (params.previous && result.fingerprint === params.previous.fingerprint) {
      return {
        sessions: params.previous.sessions,
        issues: params.previous.issues,
        fingerprint: result.fingerprint
      }
    }
    // Fall back to a full scan if the client lacks the matching previous snapshot.
    const fallbackReply = await agentHistorySessionScan.request(client, {
      limit: MOBILE_AI_VAULT_SESSION_LIMIT,
      force: true,
      scopePaths: params.scopePaths
    })
    const fallbackResult = agentHistorySessionScan.interpret(fallbackReply)
    return {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque session records
      sessions: fallbackResult.sessions as AiVaultSession[],
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque issue records
      issues: fallbackResult.issues as AiVaultScanIssue[],
      fingerprint: fallbackResult.fingerprint
    }
  }

  return {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque session records
    sessions: result.sessions as AiVaultSession[],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: opaque issue records
    issues: result.issues as AiVaultScanIssue[],
    fingerprint: result.fingerprint
  }
}
