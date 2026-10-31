import type { AgentSessionRecord } from '../../shared/agent-session-record'
import { agentSessionConversationView } from '../../shared/agent-session-conversation-view'
import { defaultAgentChatLabel } from '../../shared/agent-session/agent-session-chat-label'
import {
  isAiVaultAgent,
  isAiVaultSessionResumableContent,
  aiVaultSessionRecoverableSignalCount,
  type AiVaultListArgs,
  type AiVaultListResult,
  type AiVaultSession
} from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { structuredAgentRuntimeMetadata } from '../runtime/structured-agent-runtime-metadata'
import type { StructuredChatOpener } from './structured-session-ownership'
import type { OrchestrationDb } from '../runtime/orchestration/db'
import { z } from 'zod'
import {
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult
} from '../../shared/ai-vault-session-depth'
import { conditionalAiVaultListResult } from './session-list-fingerprint'
import { clearedInto } from '../runtime/orchestration/structured-session-lineage'
import { isGenericConversationTitle } from '../../shared/project-conversation-list'
import { conversationNameSeed } from '../../shared/conversation-name-generation'
import type { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { structuredConversationJournalPreview } from './structured-conversation-journal-preview'

export function boundedAiVaultConversationList(
  result: AiVaultListResult,
  args?: AiVaultListArgs
): AiVaultListResult {
  return conditionalAiVaultListResult(
    truncateAiVaultListResult(result, requestedAiVaultSessionDepth(args), args?.scopePaths),
    null
  )
}

/** Project the existing record catalog; provider files remain optional evidence, never identity. */
export function projectDurableAiVaultConversations(
  result: AiVaultListResult,
  records: readonly AgentSessionRecord[],
  opensChat: StructuredChatOpener,
  childSessionIds: ReadonlySet<string> = new Set(),
  journalDatabase?: JournalHostDatabase
): AiVaultListResult {
  const excluded = new Set(childSessionIds)
  const recordsById = new Map(records.map((record) => [record.sessionId, record]))
  for (const id of excluded) {
    const record = recordsById.get(id)
    const successor = record && clearedInto(agentSessionConversationView(record))
    if (successor) {
      excluded.add(successor)
    }
  }
  const bySessionId = new Map<string, AiVaultSession>()
  const otherRows: AiVaultSession[] = []
  for (const row of result.sessions) {
    if (row.executionHostId !== LOCAL_EXECUTION_HOST_ID || !row.structuredSession) {
      otherRows.push(row)
      continue
    }
    const id = row.structuredSession.sessionId
    if (excluded.has(id)) {
      continue
    }
    const previous = bySessionId.get(id)
    if (!previous || rowTime(row) > rowTime(previous)) {
      bySessionId.set(id, row)
    }
  }
  for (const record of records) {
    const registration = structuredAgentRuntimeMetadata(record.provider)
    const agent = registration?.sessionHistory.rowAgents[0]
    if (
      record.location.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
      record.location.wslDistro !== null ||
      !registration ||
      !isAiVaultAgent(agent) ||
      !opensChat(registration.definition.agent) ||
      excluded.has(record.sessionId)
    ) {
      continue
    }
    const previous = bySessionId.get(record.sessionId)
    const providerHasContent =
      previous &&
      (previous.conversationContent === 'present' ||
        (previous.conversationContent !== 'empty' && isAiVaultSessionResumableContent(previous)) ||
        aiVaultSessionRecoverableSignalCount(previous) > 0 ||
        previous.firstUserPrompt?.trim() ||
        previous.lastUserPrompt?.trim())
    const preview = providerHasContent
      ? { conversationContent: 'present' as const }
      : !previous ||
          previous.source === 'structured-record' ||
          isGenericConversationTitle(previous.title)
        ? structuredConversationJournalPreview(journalDatabase, record)
        : { conversationContent: 'unknown' as const }
    const firstUserPrompt =
      previous?.firstUserPrompt?.trim() ||
      ('firstUserPrompt' in preview ? preview.firstUserPrompt : undefined)
    const recordTitle = record.conversationName?.trim()
    const providerTitle = previous?.title.trim()
    const title =
      [recordTitle, providerTitle].find((value) => value && !isGenericConversationTitle(value)) ||
      conversationNameSeed(firstUserPrompt ?? '') ||
      recordTitle ||
      providerTitle ||
      defaultAgentChatLabel(registration.definition.agent)
    const createdAt = new Date(record.createdAt).toISOString()
    const updatedAt = new Date(
      Math.max(record.updatedAt, previous ? rowTime(previous) : 0)
    ).toISOString()
    const cwd =
      record.launchDirectory ??
      splitWorktreeIdForFilesystem(record.location.workspaceId)?.worktreePath ??
      previous?.cwd ??
      null
    bySessionId.set(record.sessionId, {
      ...(previous ?? {
        source: 'structured-record' as const,
        id: `${LOCAL_EXECUTION_HOST_ID}:structured:${record.sessionId}`,
        executionHostId: LOCAL_EXECUTION_HOST_ID,
        agent,
        sessionId: record.sessionId,
        filePath: '',
        codexHome: null,
        branch: null,
        messageCount: 0,
        totalTokens: 0,
        previewMessages: [],
        queuedMessageCount: 0,
        subagentTranscriptCount: 0,
        resumeCommand: '',
        subagent: null
      }),
      title,
      conversationContent:
        previous &&
        previous.source !== 'structured-record' &&
        previous.conversationContent !== 'empty' &&
        preview.conversationContent === 'empty'
          ? 'unknown'
          : preview.conversationContent,
      ...(firstUserPrompt ? { firstUserPrompt } : {}),
      cwd,
      model: record.options?.model ?? previous?.model ?? null,
      createdAt,
      updatedAt,
      modifiedAt: updatedAt,
      structuredSession: { sessionId: record.sessionId, workspaceId: record.location.workspaceId }
    })
  }
  return {
    ...result,
    sessions: [...otherRows, ...bySessionId.values()].sort((a, b) => rowTime(b) - rowTime(a))
  }
}

function rowTime(row: AiVaultSession): number {
  return Date.parse(row.updatedAt ?? row.modifiedAt) || 0
}

/** Child conversations are reached through the parent's journal, including after release. */
export function aiVaultOrchestrationChildSessionIds(
  source: OrchestrationDb | null | (() => OrchestrationDb | null)
): ReadonlySet<string> | null {
  try {
    const db = typeof source === 'function' ? source() : source
    if (!db?.hasAnyDispatchContexts()) {
      return new Set()
    }
    const rows = z.array(z.object({ sessionId: z.string() })).parse(
      db.db
        .prepare(`SELECT DISTINCT dispatch.assignee_orca_session_id AS sessionId FROM dispatch_contexts dispatch
        WHERE dispatch.assignee_orca_session_id IS NOT NULL AND dispatch.creator_orca_session_id IS NOT NULL
        AND dispatch.assignee_orca_session_id != dispatch.creator_orca_session_id`)
        .all()
    )
    return new Set(rows.map((row) => row.sessionId))
  } catch (error) {
    console.warn('[ai-vault] Child conversation lookup unavailable', error)
    return null
  }
}
