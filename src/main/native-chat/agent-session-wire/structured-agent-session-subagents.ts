import { join } from 'node:path'
import {
  agentSessionRecordAgent,
  type AgentSessionRecord
} from '../../../shared/agent-session-record'
import { agentSessionProviderHandleChainHead } from '../../../shared/agent-session-provider-handle'
import type { AiVaultSubagentListResult } from '../../../shared/ai-vault-types'
import { resolveSessionFilePath } from '../session-file-resolver'
import { listAiVaultSubagentSessionsInBackground } from '../../ai-vault/session-scanner-background'

/** Resolve on the owning host, using the session's pinned account rather than the current selection. */
export async function listStructuredSessionSubagents(
  record: AgentSessionRecord | null
): Promise<AiVaultSubagentListResult> {
  if (!record) {
    throw new Error('agent_session_not_found')
  }
  const agent = agentSessionRecordAgent(record)
  const transcriptAgent =
    agent === 'codex' ? 'codex' : agent === 'claude' || agent === 'openclaude' ? 'claude' : null
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!head || !transcriptAgent) {
    return { sessions: [], issues: [] }
  }
  const providerId = head.handle.provider === 'codex' ? head.handle.threadId : head.handle.sessionId
  const parentFilePath = await resolveSessionFilePath(
    agent,
    providerId,
    transcriptAgent === 'codex'
      ? { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] }
      : { claudeProjectsDir: join(record.accountHome.path, 'projects') }
  )
  return parentFilePath
    ? listAiVaultSubagentSessionsInBackground({ agent: transcriptAgent, parentFilePath })
    : { sessions: [], issues: [] }
}
