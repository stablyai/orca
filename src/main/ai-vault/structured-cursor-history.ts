import { projectStructuredAiVaultSessions } from './structured-session-ownership'
import type { AgentSessionRecord } from '../../shared/agent-session-record'
import type { AgentSessionHistoryPage } from '../../shared/agent-session-wire'
import {
  createNormalizedPathInsideOrEqualMatcher,
  normalizeRuntimePathForComparison
} from '../../shared/cross-platform-path'
import type {
  AiVaultListArgs,
  AiVaultListResult,
  AiVaultSession
} from '../../shared/ai-vault-types'
import { agentSessionProviderHandleChainHead } from '../../shared/agent-session-provider-handle'
import {
  aiVaultScanLimit,
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult
} from '../../shared/ai-vault-session-depth'
import { journalDatabasePath } from '../native-chat/agent-session-journal/journal-host-database'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'

export type StructuredCursorHistorySource = {
  listRecords: () => readonly AgentSessionRecord[]
  stateDirectory: string
  resolveWorkspacePath?: (workspaceId: string) => Promise<string>
  history: (sessionId: string) => Promise<AgentSessionHistoryPage>
}

/** ACP history lives in the native journal; Cursor's terminal scanner cannot discover it. */
export async function appendStructuredCursorHistory(
  result: AiVaultListResult,
  supported: boolean,
  args?: AiVaultListArgs,
  source?: StructuredCursorHistorySource
): Promise<AiVaultListResult> {
  if (!supported) {
    return result
  }
  if (!source) {
    const host = getStructuredAgentSessionHost()
    if (!host) {
      return result
    }
    source = {
      listRecords: host.deps.store.listRecords,
      stateDirectory: host.deps.journalDatabase.stateDirectory,
      ...(host.deps.resolveWorkspacePath
        ? { resolveWorkspacePath: host.deps.resolveWorkspacePath }
        : {}),
      history: async (sessionId) =>
        (await host.history({ sessionId, direction: 'tail', limit: 50 })).page
    }
  }
  const sessions: AiVaultSession[] = [...result.sessions]
  const issues = [...result.issues]
  const records = source
    .listRecords()
    .filter((record) => record.provider === 'cursor' && record.location.wslDistro === null)
    .sort((left, right) => right.updatedAt - left.updatedAt)
  const depth = aiVaultScanLimit(args)
  const scopeMatchers = args?.scopePaths?.map(createNormalizedPathInsideOrEqualMatcher) ?? []
  let visited = 0
  let scoped = 0
  for (const record of records) {
    if (visited >= depth && (scopeMatchers.length === 0 || scoped >= depth)) {
      break
    }
    const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
    if (
      head?.handle.provider !== 'cursor' ||
      sessions.some((session) => session.structuredSession?.sessionId === record.sessionId)
    ) {
      continue
    }
    const filePath = journalDatabasePath(source.stateDirectory)
    try {
      const cwd = (await source.resolveWorkspacePath?.(record.location.workspaceId)) ?? null
      const inScope =
        cwd !== null &&
        scopeMatchers.some((matches) => matches(normalizeRuntimePathForComparison(cwd)))
      if (visited >= depth && !inScope) {
        continue
      }
      visited += 1
      if (inScope) {
        scoped += 1
      }
      const page = await source.history(record.sessionId)
      const previewMessages = page.items.flatMap((item) => {
        if (
          item.body.kind !== 'message' ||
          (item.body.role !== 'user' && item.body.role !== 'assistant')
        ) {
          return []
        }
        return [
          {
            role: item.body.role,
            text: item.body.blocks
              .flatMap((block) => (block.type === 'text' ? [block.text] : []))
              .join('\n'),
            timestamp: new Date(item.observedAt).toISOString()
          }
        ]
      })
      sessions.push({
        id: `${record.location.executionHostId}:cursor:native:${record.sessionId}`,
        executionHostId: record.location.executionHostId,
        agent: 'cursor',
        sessionId: head.handle.sessionId,
        title:
          record.conversationName ??
          previewMessages.find((message) => message.role === 'user')?.text.slice(0, 160) ??
          'Cursor',
        cwd,
        branch: null,
        model: record.options?.model ?? null,
        filePath,
        codexHome: null,
        createdAt: new Date(record.createdAt).toISOString(),
        updatedAt: new Date(record.updatedAt).toISOString(),
        modifiedAt: new Date(record.updatedAt).toISOString(),
        messageCount: previewMessages.length,
        totalTokens: 0,
        previewMessages,
        previewMessagesTruncated: page.hasOlder,
        queuedMessageCount: page.queuedMessages?.length ?? 0,
        subagentTranscriptCount: 0,
        resumeCommand: '',
        subagent: null,
        structuredSession: { sessionId: record.sessionId, workspaceId: record.location.workspaceId }
      })
    } catch (error) {
      issues.push({
        agent: 'cursor',
        path: filePath,
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }
  sessions.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))
  return truncateAiVaultListResult(
    { ...result, sessions, issues },
    requestedAiVaultSessionDepth(args),
    args?.scopePaths
  )
}

export function projectStructuredCursorHistory(
  result: AiVaultListResult,
  args?: AiVaultListArgs
): Promise<AiVaultListResult> {
  return appendStructuredCursorHistory(projectStructuredAiVaultSessions(result, true), true, args)
}
