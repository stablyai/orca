import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  AI_VAULT_SESSION_LIST_MAX_JSON_BYTES,
  retainAiVaultSessionsWithinAggregate
} from './session-list-retention'
import { sessionSortTime } from './session-scanner-accumulator'

export function retainClaudeSubagentSessionBatch(
  retainedSessions: readonly AiVaultSession[],
  batch: readonly (AiVaultSession | null)[],
  maxBytes: number = AI_VAULT_SESSION_LIST_MAX_JSON_BYTES
): { sessions: AiVaultSession[]; omitted: number } {
  const candidates = [
    ...retainedSessions,
    ...batch.filter((session): session is AiVaultSession => session !== null)
  ]
  candidates.sort((left, right) => sessionSortTime(right) - sessionSortTime(left))
  return retainAiVaultSessionsWithinAggregate(candidates, maxBytes)
}
