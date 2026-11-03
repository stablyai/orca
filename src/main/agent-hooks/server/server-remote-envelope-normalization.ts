import { normalizeAgentProviderSession } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  normalizeClaudePromptId,
  normalizeGrokPromptId
} from '../../../shared/agent-hook-listener/listener-limits'
import { isAgentHookSource, type AgentHookSource } from '../../../shared/agent-hook-relay'
import {
  readClaudePermissionProjection,
  type ClaudePermissionProjection
} from '../../../shared/agent-hook-listener/claude-permission-facts'
import {
  readClaudeSettledRequests,
  type ClaudeSettledRequest
} from '../../../shared/agent-hook-listener/claude-settled-permission-requests'

export type RemoteAgentStatusEnvelope = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  env?: string
  version?: string
  launchToken?: string
  hostTurnRevision?: unknown
  hasExplicitPrompt?: boolean
  promptInteractionKey?: string
  agentPresence?: unknown
  hookEventName?: string
  source?: unknown
  providerPromptId?: unknown
  grokPromptBoundary?: unknown
  compactTrigger?: unknown
  toolUseId?: string
  claudeSettledRequests?: unknown
  claudePermission?: unknown
  toolAgentId?: string
  teammateName?: string
  toolAgentType?: string
  providerSession?: unknown
  providerSessionOnly?: unknown
  isReplay?: boolean
  turnEndedAt?: unknown
  turnEndDisposition?: unknown
  /** Fields shed to fit the relay frame; validate before restoration. */
  shedFields?: unknown
  claudeRunningNonAgentTask?: unknown
  /** Producing peer capabilities; absent on older peers, which use legacy defaults. */
  advertisedAgentStatusCapabilities?: readonly string[]
  statusUnavailable?: unknown
  evidenceAgeMs?: unknown
  payload: unknown
}

export type RemoteEnvelopeFields = {
  hookEventName?: string
  source?: AgentHookSource
  providerPromptId?: string
  grokPromptBoundary?: true
  compactTrigger?: 'manual' | 'auto'
  worktreeId?: string
  promptInteractionKey?: string
  toolUseId?: string
  claudeSettledRequests?: readonly ClaudeSettledRequest[]
  claudePermission?: ClaudePermissionProjection
  toolAgentId?: string
  teammateName?: string
  toolAgentType?: string
  providerSession?: NonNullable<ReturnType<typeof normalizeAgentProviderSession>>
}

export function normalizeRemoteEnvelopeFields(envelope: {
  hookEventName?: string
  source?: unknown
  providerPromptId?: unknown
  grokPromptBoundary?: unknown
  compactTrigger?: unknown
  worktreeId?: string
  promptInteractionKey?: string
  toolUseId?: string
  claudeSettledRequests?: unknown
  claudePermission?: unknown
  isReplay?: boolean
  toolAgentId?: string
  teammateName?: string
  toolAgentType?: string
  providerSession?: unknown
}): RemoteEnvelopeFields {
  const source = isAgentHookSource(envelope.source) ? envelope.source : undefined
  const claudePermission =
    source === 'claude' ? readClaudePermissionProjection(envelope.claudePermission) : undefined
  // A replayed projection names the held request itself; its identity replaces the cached row's.
  const row = claudePermission?.row
  return {
    ...readRemoteHookIdentity(row ?? envelope),
    ...(claudePermission ? { claudePermission } : {}),
    source,
    providerPromptId:
      source === 'claude'
        ? normalizeClaudePromptId(envelope.providerPromptId)
        : source === 'grok'
          ? normalizeGrokPromptId(envelope.providerPromptId)
          : undefined,
    grokPromptBoundary:
      source === 'grok' && envelope.grokPromptBoundary === true ? true : undefined,
    compactTrigger:
      source === 'claude' &&
      (envelope.compactTrigger === 'manual' || envelope.compactTrigger === 'auto')
        ? envelope.compactTrigger
        : undefined,
    worktreeId:
      envelope.worktreeId !== undefined && envelope.worktreeId.trim().length > 0
        ? envelope.worktreeId.trim()
        : undefined,
    promptInteractionKey:
      typeof envelope.promptInteractionKey === 'string' &&
      envelope.promptInteractionKey.trim().length > 0
        ? envelope.promptInteractionKey.trim()
        : undefined,
    // Live hooks settle their own requests; retained settlements only repair replay gaps.
    claudeSettledRequests:
      source === 'claude' && envelope.isReplay === true
        ? readClaudeSettledRequests(envelope.claudeSettledRequests)
        : undefined,
    teammateName:
      typeof envelope.teammateName === 'string' && envelope.teammateName.trim().length > 0
        ? envelope.teammateName.trim()
        : undefined,
    providerSession: normalizeAgentProviderSession(envelope.providerSession) ?? undefined
  }
}

function readRemoteHookIdentity(envelope: {
  hookEventName?: string
  toolUseId?: string
  toolAgentId?: string
  toolAgentType?: string
}): Pick<RemoteEnvelopeFields, 'hookEventName' | 'toolUseId' | 'toolAgentId' | 'toolAgentType'> {
  const read = (value: string | undefined) =>
    typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
  return {
    hookEventName: read(envelope.hookEventName),
    toolUseId: read(envelope.toolUseId),
    toolAgentId: read(envelope.toolAgentId),
    toolAgentType: read(envelope.toolAgentType)
  }
}
