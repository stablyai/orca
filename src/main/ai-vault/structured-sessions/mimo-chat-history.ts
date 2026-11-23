import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import { createAiVaultScopeCwdMatcher } from '../../../shared/ai-vault/scanning/ai-vault-scope-cwd-match'
import {
  LOCAL_EXECUTION_HOST_ID,
  requestedExecutionHostScope
} from '../../../shared/execution-host/execution-host'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { defaultAgentChatLabel } from '../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import type { AgentSessionConversationKeys } from '../../runtime/agent-session/records/agent-session-conversation-key-index'
import { mergeAiVaultListResults } from '../listing/session-list-results'
import { ownedRowLastTurnPreview } from './owned-history-row-content'

const MIMO = 'mimo-code'
// A fixed getter lets the record store reuse the index across refreshes.
const mimoHistoryKeys: AgentSessionConversationKeys = ({ provider }) =>
  provider === MIMO ? [MIMO] : []

/** MiMo Chat owns a journal, not a readable History transcript or terminal resume handle. */
export function includeLocalMimoHistory(
  result: AiVaultListResult,
  args?: AiVaultListArgs
): AiVaultListResult {
  if (result.cancelled || result.unchanged) {
    return result
  }
  const scope = requestedExecutionHostScope(args?.executionHostScope)
  const store = getStructuredAgentSessionHost()?.deps.store
  if (!store || (scope !== 'all' && scope !== LOCAL_EXECUTION_HOST_ID)) {
    return result
  }
  const seen = new Set(
    result.sessions.flatMap((row) =>
      row.executionHostId === LOCAL_EXECUTION_HOST_ID && row.structuredSession
        ? [row.structuredSession.sessionId]
        : []
    )
  )
  const inScope = createAiVaultScopeCwdMatcher(args?.scopePaths ?? [])
  const sessions: AiVaultSession[] = []
  for (const { sessionId } of store.conversationsKeyedBy(mimoHistoryKeys, MIMO)) {
    const record = store.getRecord(sessionId)
    if (
      !record ||
      record.provider !== MIMO ||
      record.location.wslDistro !== null ||
      record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      seen.has(sessionId) ||
      !record.launchDirectory ||
      (args?.scopeOnly && !inScope(record.launchDirectory))
    ) {
      continue
    }
    const timestamp = new Date(record.lastTurn?.at ?? record.updatedAt).toISOString()
    const row: AiVaultSession = {
      id: `local:${MIMO}:chat:${sessionId}`,
      executionHostId: LOCAL_EXECUTION_HOST_ID,
      agent: MIMO,
      sessionId,
      title: record.conversationName ?? defaultAgentChatLabel(MIMO),
      cwd: record.launchDirectory,
      branch: null,
      model: null,
      filePath: '',
      codexHome: null,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: timestamp,
      modifiedAt: timestamp,
      messageCount: 0,
      totalTokens: 0,
      previewMessages: [],
      queuedMessageCount: 0,
      subagentTranscriptCount: 0,
      resumeCommand: '',
      subagent: null,
      structuredSession: { sessionId, workspaceId: record.location.workspaceId }
    }
    const preview = ownedRowLastTurnPreview(row, sessionId)
    if (preview) {
      seen.add(sessionId)
      sessions.push({ ...row, ...preview })
    }
  }
  return sessions.length
    ? {
        ...result,
        ...mergeAiVaultListResults(
          [result, { sessions, issues: [], scannedAt: result.scannedAt }],
          args?.limit,
          args?.unlimited,
          args?.scopePaths
        ),
        fingerprint: undefined
      }
    : result
}
