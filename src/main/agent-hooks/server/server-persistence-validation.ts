import { createHash } from 'node:crypto'

import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import {
  normalizeAgentStatusPayload,
  type ParsedAgentStatusPayload
} from '../../../shared/agent-status-types'
import { isAgentHookSource } from '../../../shared/agent-hook-relay'
import { normalizeClaudePromptId } from '../../../shared/agent-hook-listener/listener-limits'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import type { AgentHookAuthorityEvidence, EnrichedAgentHookEventPayload } from './server-types'
import { isValidPaneKey, isValidPiProviderSessionOnly } from './server-status-identity'

export function dropHydratedIdleClaudeSubagents(
  payload: ParsedAgentStatusPayload
): ParsedAgentStatusPayload {
  if (
    payload.agentType !== 'claude' ||
    !payload.subagents?.some((subagent) => subagent.state === 'idle')
  ) {
    return payload
  }
  const activeSubagents = payload.subagents.filter((subagent) => subagent.state !== 'idle')
  // Why: an idle teammate's liveness can't be proven across a restart (its TeammateIdle confirmation is in-memory); prune so a dead pile can't resurrect — a live teammate re-earns its row via SubagentStart.
  return {
    ...payload,
    subagents: activeSubagents.length > 0 ? activeSubagents : undefined
  }
}

export function sanitizeHydratedEntry(
  paneKey: string,
  rawEntry: unknown
): EnrichedAgentHookEventPayload | null {
  const parsedPaneKey = parsePaneKey(paneKey)
  if (!parsedPaneKey) {
    return null
  }
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const record = rawEntry as Record<string, unknown>
  if (record.paneKey !== paneKey) {
    return null
  }
  const tabId = record.tabId
  if (tabId !== undefined && (typeof tabId !== 'string' || tabId.length === 0)) {
    return null
  }
  // Why: a stored tabId that diverges from the paneKey's tab segment is corruption; drop instead of hydrating an inconsistent row.
  if (typeof tabId === 'string' && tabId !== parsedPaneKey.tabId) {
    return null
  }
  const worktreeId = record.worktreeId
  if (worktreeId !== undefined && (typeof worktreeId !== 'string' || worktreeId.length === 0)) {
    return null
  }
  const receivedAt = record.receivedAt
  if (typeof receivedAt !== 'number' || !Number.isFinite(receivedAt) || receivedAt <= 0) {
    return null
  }
  const stateStartedAt = record.stateStartedAt
  if (
    typeof stateStartedAt !== 'number' ||
    !Number.isFinite(stateStartedAt) ||
    stateStartedAt <= 0
  ) {
    return null
  }
  // Why: connectionId is null (local) or string (relay); any other shape is rejected to keep the typed surface honest.
  const connectionIdRaw = record.connectionId
  let connectionId: string | null
  if (connectionIdRaw === null || connectionIdRaw === undefined) {
    connectionId = null
  } else if (typeof connectionIdRaw === 'string') {
    connectionId = connectionIdRaw
  } else {
    return null
  }
  const payload = normalizeAgentStatusPayload(record.payload)
  if (!payload) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(record.providerSession) ?? undefined
  const providerSessionOnly = record.providerSessionOnly === true
  const retainedForLiveness = record.retainedForLiveness === true
  const validRetainedIdentity = Boolean(
    retainedForLiveness && providerSession && payload.agentType && payload.agentType !== 'unknown'
  )
  if (
    providerSessionOnly &&
    !isValidPiProviderSessionOnly(providerSession, payload.agentType) &&
    !validRetainedIdentity
  ) {
    return null
  }
  const source = isAgentHookSource(record.source) ? record.source : undefined
  const providerPromptId =
    source === 'claude' ? normalizeClaudePromptId(record.providerPromptId) : undefined
  const compactTrigger =
    source === 'claude' && (record.compactTrigger === 'manual' || record.compactTrigger === 'auto')
      ? record.compactTrigger
      : undefined
  return {
    paneKey,
    source,
    tabId: typeof tabId === 'string' ? tabId : undefined,
    worktreeId: typeof worktreeId === 'string' ? worktreeId : undefined,
    connectionId,
    hasExplicitPrompt: record.hasExplicitPrompt === true ? true : undefined,
    hookEventName: typeof record.hookEventName === 'string' ? record.hookEventName : undefined,
    providerPromptId,
    compactTrigger,
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : undefined,
    toolAgentId: typeof record.toolAgentId === 'string' ? record.toolAgentId : undefined,
    teammateName: typeof record.teammateName === 'string' ? record.teammateName : undefined,
    toolAgentType: typeof record.toolAgentType === 'string' ? record.toolAgentType : undefined,
    claudeLeadBoundaryChildOnly: record.claudeLeadBoundaryChildOnly === true ? true : undefined,
    providerSession,
    providerSessionOnly: providerSessionOnly ? true : undefined,
    retainedForLiveness: retainedForLiveness ? true : undefined,
    payload,
    receivedAt,
    stateStartedAt
  }
}

export function readPersistedLaunchTokenHash(rawEntry: unknown): string | null {
  if (typeof rawEntry !== 'object' || rawEntry === null) {
    return null
  }
  const record = rawEntry as Record<string, unknown>
  const launchTokenHash =
    typeof record.launchTokenHash === 'string' ? record.launchTokenHash.trim() : ''
  if (/^[a-f0-9]{64}$/.test(launchTokenHash)) {
    return launchTokenHash
  }
  const legacyLaunchToken = typeof record.launchToken === 'string' ? record.launchToken.trim() : ''
  return legacyLaunchToken ? createHash('sha256').update(legacyLaunchToken).digest('hex') : null
}

export function sanitizePersistedAuthorityCommitment(
  paneKey: string,
  value: unknown
): AgentHookAuthorityEvidence | null {
  if (!isValidPaneKey(paneKey) || typeof value !== 'object' || value === null) {
    return null
  }
  const record = value as Record<string, unknown>
  const launchTokenHash =
    typeof record.launchTokenHash === 'string' ? record.launchTokenHash.trim() : ''
  const connectionId = record.connectionId
  const observedAt = record.observedAt
  if (
    !/^[a-f0-9]{64}$/.test(launchTokenHash) ||
    (connectionId !== null && typeof connectionId !== 'string') ||
    typeof observedAt !== 'number' ||
    !Number.isFinite(observedAt)
  ) {
    return null
  }
  return Object.freeze({
    paneKey,
    launchTokenHash,
    connectionId: connectionId as string | null,
    ...(typeof record.tabId === 'string' ? { tabId: record.tabId } : {}),
    ...(typeof record.worktreeId === 'string' ? { worktreeId: record.worktreeId } : {}),
    observedAt
  })
}

export function authorityCommitmentsMatch(
  left: AgentHookAuthorityEvidence,
  right: AgentHookAuthorityEvidence
): boolean {
  return (
    left.paneKey === right.paneKey &&
    left.launchTokenHash === right.launchTokenHash &&
    left.connectionId === right.connectionId &&
    left.tabId === right.tabId &&
    left.worktreeId === right.worktreeId
  )
}
