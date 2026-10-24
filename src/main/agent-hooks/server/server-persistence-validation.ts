import { readAgentProcessPresence } from '../../../shared/agent-process-presence'
import { createHash } from 'node:crypto'

import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import {
  isTurnEndDisposition,
  normalizeAgentStatusPayload,
  type AgentMainAgentStatus,
  type ParsedAgentStatusPayload
} from '../../../shared/agent-status-types'
import { isAgentHookSource } from '../../../shared/agent-hook-relay'
import type { HostTurnRecord } from '../../../shared/agent-hook-listener/listener-event'
import { isTurnEndedAt } from '../../../shared/agent-hook-turn-end-timing'
import { isRecord } from '../../../shared/agent-status-child-work-value-guards'
import {
  normalizeClaudePromptId,
  normalizeGrokPromptId
} from '../../../shared/agent-hook-listener/listener-limits'
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
  // Idle teammates cannot prove liveness across restart; fresh hooks must restore them.
  return {
    ...payload,
    subagents: activeSubagents.length > 0 ? activeSubagents : undefined
  }
}

/** Old caches use claudeLeadBoundaryChildOnly for a settled main agent; honor it only without mainAgent. */
function legacyChildOnlyBoundaryMainAgent(
  payload: ParsedAgentStatusPayload,
  record: Record<string, unknown>,
  stateStartedAt: number
): AgentMainAgentStatus | undefined {
  if (
    payload.mainAgent !== undefined ||
    record.claudeLeadBoundaryChildOnly !== true ||
    payload.agentType !== 'claude'
  ) {
    return undefined
  }
  // Older rows may lack the main-agent end stamp; use their row clock as the fallback.
  return { state: 'done', stateStartedAt: payload.turnCompletedAt ?? stateStartedAt }
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
  // Structured rows come from the journal projection, never this cache.
  if (record.structuredHost !== undefined) {
    return null
  }
  const tabId = record.tabId
  if (tabId !== undefined && (typeof tabId !== 'string' || tabId.length === 0)) {
    return null
  }
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
  const connectionIdRaw = record.connectionId
  let connectionId: string | null
  if (connectionIdRaw === null || connectionIdRaw === undefined) {
    connectionId = null
  } else if (typeof connectionIdRaw === 'string') {
    connectionId = connectionIdRaw
  } else {
    return null
  }
  const normalizedPayload = normalizeAgentStatusPayload(record.payload)
  if (!normalizedPayload) {
    return null
  }
  const legacyBoundaryMainAgent = legacyChildOnlyBoundaryMainAgent(
    normalizedPayload,
    record,
    stateStartedAt
  )
  const payload = legacyBoundaryMainAgent
    ? { ...normalizedPayload, mainAgent: legacyBoundaryMainAgent }
    : normalizedPayload
  const claudeRunningNonAgentTask =
    typeof record.claudeRunningNonAgentTask === 'boolean'
      ? record.claudeRunningNonAgentTask
      : // The legacy child-only flag also proved no shell work remained.
        legacyBoundaryMainAgent
        ? false
        : undefined
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
    source === 'claude'
      ? normalizeClaudePromptId(record.providerPromptId)
      : source === 'grok'
        ? normalizeGrokPromptId(record.providerPromptId)
        : undefined
  const compactTrigger =
    source === 'claude' && (record.compactTrigger === 'manual' || record.compactTrigger === 'auto')
      ? record.compactTrigger
      : undefined
  const turnStartedAt = record.turnStartedAt
  const turnEndedAt = record.turnEndedAt
  const hostTurn = readHostTurnRecord(record.hostTurn)
  return {
    paneKey,
    agentPresence: readAgentProcessPresence(record.agentPresence),
    source,
    tabId: typeof tabId === 'string' ? tabId : undefined,
    worktreeId: typeof worktreeId === 'string' ? worktreeId : undefined,
    connectionId,
    hasExplicitPrompt: record.hasExplicitPrompt === true ? true : undefined,
    hookEventName: typeof record.hookEventName === 'string' ? record.hookEventName : undefined,
    providerPromptId,
    grokPromptBoundary: source === 'grok' && record.grokPromptBoundary === true ? true : undefined,
    compactTrigger,
    toolUseId: typeof record.toolUseId === 'string' ? record.toolUseId : undefined,
    toolAgentId: typeof record.toolAgentId === 'string' ? record.toolAgentId : undefined,
    teammateName: typeof record.teammateName === 'string' ? record.teammateName : undefined,
    toolAgentType: typeof record.toolAgentType === 'string' ? record.toolAgentType : undefined,
    ...(claudeRunningNonAgentTask !== undefined ? { claudeRunningNonAgentTask } : {}),
    providerSession,
    providerSessionOnly: providerSessionOnly ? true : undefined,
    retainedForLiveness: retainedForLiveness ? true : undefined,
    payload,
    receivedAt,
    stateStartedAt,
    ...(typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt) && turnStartedAt > 0
      ? { turnStartedAt }
      : {}),
    ...(isTurnEndedAt(turnEndedAt) ? { turnEndedAt } : {}),
    ...(isTurnEndDisposition(record.turnEndDisposition)
      ? { turnEndDisposition: record.turnEndDisposition }
      : {}),
    ...(hostTurn ? { hostTurn } : {})
  }
}

function readHostTurnRecord(value: unknown): HostTurnRecord | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { owner, currentTurnKey, completed } = value
  if (typeof owner !== 'string' || typeof currentTurnKey !== 'string') {
    return undefined
  }
  if (completed === undefined) {
    return { owner, currentTurnKey }
  }
  return isRecord(completed) &&
    typeof completed.turnKey === 'string' &&
    isTurnEndedAt(completed.endedAt)
    ? {
        owner,
        currentTurnKey,
        completed: { turnKey: completed.turnKey, endedAt: completed.endedAt }
      }
    : undefined
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
