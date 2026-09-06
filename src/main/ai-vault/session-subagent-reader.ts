import type { AiVaultSubagentListResult } from '../../shared/ai-vault-types'
import { listClaudeSubagentSessions } from './session-scanner-claude-subagents'
import { listCodexSubagentSessions } from './session-scanner-codex-subagents'
import { listOmpSubagentSessions } from './session-scanner-omp-subagent-listing'
import type { AiVaultServiceSubagentRequest } from './session-scanner-service-protocol'

export function listLocalAiVaultSubagentSessions(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  if (request.agent === 'claude') {
    return listClaudeSubagentSessions({ parentFilePath: request.parentFilePath })
  }
  return request.agent === 'omp'
    ? listOmpSubagentSessions({ parentFilePath: request.parentFilePath })
    : listCodexSubagentSessions({ parentFilePath: request.parentFilePath })
}
