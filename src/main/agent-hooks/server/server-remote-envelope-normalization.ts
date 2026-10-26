import { normalizeAgentProviderSession } from '../../../shared/agent-session-resume'
import {
  normalizeClaudePromptId,
  normalizeGrokPromptId
} from '../../../shared/agent-hook-listener/listener-limits'
import { isAgentHookSource, type AgentHookSource } from '../../../shared/agent-hook-relay'
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
  isReplay?: boolean
  toolAgentId?: string
  teammateName?: string
  toolAgentType?: string
  providerSession?: unknown
}): RemoteEnvelopeFields {
  const source = isAgentHookSource(envelope.source) ? envelope.source : undefined
  return {
    hookEventName:
      typeof envelope.hookEventName === 'string' && envelope.hookEventName.trim().length > 0
        ? envelope.hookEventName.trim()
        : undefined,
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
    toolUseId:
      typeof envelope.toolUseId === 'string' && envelope.toolUseId.trim().length > 0
        ? envelope.toolUseId.trim()
        : undefined,
    // Live hooks settle their own requests; retained settlements only repair replay gaps.
    claudeSettledRequests:
      source === 'claude' && envelope.isReplay === true
        ? readClaudeSettledRequests(envelope.claudeSettledRequests)
        : undefined,
    toolAgentId:
      typeof envelope.toolAgentId === 'string' && envelope.toolAgentId.trim().length > 0
        ? envelope.toolAgentId.trim()
        : undefined,
    teammateName:
      typeof envelope.teammateName === 'string' && envelope.teammateName.trim().length > 0
        ? envelope.teammateName.trim()
        : undefined,
    toolAgentType:
      typeof envelope.toolAgentType === 'string' && envelope.toolAgentType.trim().length > 0
        ? envelope.toolAgentType.trim()
        : undefined,
    providerSession: normalizeAgentProviderSession(envelope.providerSession) ?? undefined
  }
}
