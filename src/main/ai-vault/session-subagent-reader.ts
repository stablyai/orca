import type { AiVaultSubagentListResult } from '../../shared/ai-vault/contracts/ai-vault-types'
import { listClaudeSubagentSessions } from './scanners/claude/session-scanner-claude-subagents'
import { listCodexChildSessions } from './scanners/codex/session-scanner-codex-children'
import { listOmpSubagentSessions } from './scanners/omp/session-scanner-omp-subagent-listing'
import type { AiVaultServiceSubagentRequest } from './scan-service/session-scanner-service-protocol'

export function listLocalAiVaultSubagentSessions(
  request: AiVaultServiceSubagentRequest
): Promise<AiVaultSubagentListResult> {
  if (request.agent === 'codex') {
    return request.sessionsRoot
      ? listCodexChildSessions({
          parentFilePath: request.parentFilePath,
          sessionsRoot: request.sessionsRoot
        })
      : Promise.resolve({ sessions: [], issues: [] })
  }
  return request.agent === 'claude'
    ? listClaudeSubagentSessions({ parentFilePath: request.parentFilePath })
    : listOmpSubagentSessions({ parentFilePath: request.parentFilePath })
}
