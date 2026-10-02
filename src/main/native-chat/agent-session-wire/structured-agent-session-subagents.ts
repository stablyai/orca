import { join, resolve } from 'node:path'
import {
  agentSessionRecordAgent,
  type AgentSessionRecord
} from '../../../shared/agent-session-record'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleRoot
} from '../../../shared/agent-session-provider-handle'
import type { AiVaultSubagentListResult } from '../../../shared/ai-vault-types'
import { resolveNativeChatTranscriptAgent } from '../../../shared/native-chat-agent-support'
import { resolveSessionFilePath } from '../session-file-resolver'
import { listAiVaultSubagentSessionsInBackground } from '../../ai-vault/session-scanner-background'
import { journalIdentityFor } from './structured-agent-session-attach'
import type {
  StructuredAgentSessionHostDeps,
  StructuredAgentSessionHostSession
} from './structured-agent-session-host-types'

export async function listHostSubagentSessions(
  deps: {
    store: Pick<StructuredAgentSessionHostDeps['store'], 'getRecord'>
    adapter: Pick<StructuredAgentSessionHostDeps['adapter'], 'historyFilePath' | 'readSubagents'>
  },
  sessions: ReadonlyMap<string, StructuredAgentSessionHostSession>,
  sessionId: string,
  parentFilePath?: string
): Promise<AiVaultSubagentListResult> {
  const record = deps.store.getRecord(sessionId)
  const session = sessions.get(sessionId)
  const transcriptPath =
    record && session
      ? await deps.adapter.historyFilePath?.({
          identity: journalIdentityFor(record, session.params)
        })
      : null
  const result = await listStructuredSessionSubagents(record, transcriptPath, parentFilePath)
  const live = new Map(
    (deps.adapter.readSubagents?.(sessionId) ?? []).flatMap((child) =>
      child.transcriptPath ? [[resolve(child.transcriptPath), child] as const] : []
    )
  )
  return {
    ...result,
    sessions: result.sessions.map((child) => {
      const snapshot = live.get(resolve(child.filePath))
      return snapshot && child.subagent
        ? {
            ...child,
            subagent: { ...child.subagent, status: snapshot.runStatus ?? child.subagent.status }
          }
        : child
    })
  }
}

/** Resolve on the owning host, using the session's pinned account rather than the current selection. */
export async function listStructuredSessionSubagents(
  record: AgentSessionRecord | null,
  transcriptPath?: string | null,
  requestedParentFilePath?: string
): Promise<AiVaultSubagentListResult> {
  if (!record) {
    throw new Error('agent_session_not_found')
  }
  const agent = agentSessionRecordAgent(record)
  const transcriptAgent = resolveNativeChatTranscriptAgent(agent)
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)
  if (!head || !transcriptAgent) {
    return { sessions: [], issues: [] }
  }
  const providerId = head.handle.provider === 'codex' ? head.handle.threadId : head.handle.sessionId
  const pinnedPath =
    record.providerTranscript?.handleRoot === agentSessionProviderHandleRoot(head.handle)
      ? record.providerTranscript.path
      : null
  const parentFilePath = await resolveSessionFilePath(agent, providerId, {
    ...{
      claude: { claudeProjectsDir: join(record.accountHome.path, 'projects') },
      codex: { codexSessionsDirs: [join(record.accountHome.path, 'sessions')] },
      grok: { grokSessionsDir: join(record.accountHome.path, '.grok', 'sessions') },
      omp: {
        ompSessionsDir: join(record.accountHome.path, '.omp', 'agent', 'sessions')
      }
    }[transcriptAgent],
    ...(transcriptPath || pinnedPath ? { transcriptPath: transcriptPath || pinnedPath! } : {})
  })
  if (!parentFilePath) {
    return { sessions: [], issues: [] }
  }
  const list = (path: string) =>
    listAiVaultSubagentSessionsInBackground({ agent: transcriptAgent, parentFilePath: path })
  const result = await list(parentFilePath)
  if (!requestedParentFilePath) {
    return result
  }
  // Authorize descendants through provider lineage, not a client-supplied filesystem prefix.
  const requested = resolve(requestedParentFilePath)
  if (requested === resolve(parentFilePath)) {
    return result
  }
  const pending = [...result.sessions]
  const visited = new Set([resolve(parentFilePath)])
  while (pending.length > 0) {
    const selected = pending.find((child) => resolve(child.filePath) === requested)
    if (selected) {
      return list(selected.filePath)
    }
    if (visited.size >= 256 || pending.length > 4096) {
      throw new Error('agent_session_subagent_lineage_limit')
    }
    const child = pending.pop()!
    const path = resolve(child.filePath)
    if (visited.has(path)) {
      continue
    }
    visited.add(path)
    const nested = await list(child.filePath)
    if (path === requested) {
      return nested
    }
    pending.push(...nested.sessions)
  }
  throw new Error('agent_session_operation_invalid')
}
