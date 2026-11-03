import type { AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import { listClaudeSubagentSessions } from './scanners/claude/session-scanner-claude-subagents'
import { listOmpSubagentSessions } from './scanners/omp/session-scanner-omp-subagent-listing'
import type { AiVaultServiceSubagentRequest } from './scan-service/session-scanner-service-protocol'

export function listLocalAiVaultSubagentSessions(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  return request.agent === 'claude'
    ? listClaudeSubagentSessions({ parentFilePath: request.parentFilePath })
    : listOmpSubagentSessions({ parentFilePath: request.parentFilePath })
}
