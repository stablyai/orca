import type { AiVaultSubagentListResult } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { listClaudeSubagentSessions } from '../scanners/claude/session-scanner-claude-subagents'
import { listOmpSubagentSessions } from '../scanners/omp/session-scanner-omp-subagent-listing'
import { listPiSubagentSessions } from '../scanners/pi/session-scanner-pi-subagent-listing'
import type { AiVaultServiceSubagentRequest } from './session-scanner-service-protocol'

export function listLocalAiVaultSubagentSessions(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  switch (request.agent) {
    case 'claude':
      return listClaudeSubagentSessions({ parentFilePath: request.parentFilePath })
    case 'pi':
      return listPiSubagentSessions({ parentFilePath: request.parentFilePath })
    case 'omp':
      return listOmpSubagentSessions({ parentFilePath: request.parentFilePath })
  }
}
