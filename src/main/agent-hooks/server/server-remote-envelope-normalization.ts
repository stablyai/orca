import {
  readClaudePermissionState,
  type ClaudePermissionState
} from '../../../shared/agent-hook-listener/claude-permission-projection'
import { normalizeAgentProviderSession } from '../../../shared/agent-session/lifecycle/agent-session-resume'
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
  claudePermissionState?: unknown
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
  claudePermissionState?: ClaudePermissionState
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
  claudePermissionState?: unknown
  claudeSettledRequests?: unknown
  isReplay?: boolean
  toolAgentId?: string
  teammateName?: string
  toolAgentType?: string
  providerSession?: unknown
}): RemoteEnvelopeFields {
  const source = isAgentHookSource(envelope.source) ? envelope.source : undefined
  const permission =
    source === 'claude' ? readClaudePermissionState(envelope.claudePermissionState) : undefined
  // Legacy fields name a pending request for older receivers; this receiver reads the row's own hook.
  const hook = permission?.cause ?? envelope
  const hookEventName =
    typeof hook.hookEventName === 'string' && hook.hookEventName.trim().length > 0
      ? hook.hookEventName.trim()
      : undefined
  return {
    hookEventName,
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
      typeof hook.toolUseId === 'string' && hook.toolUseId.trim().length > 0
        ? hook.toolUseId.trim()
        : undefined,
    claudePermissionState: permission?.state,
    // Only settlement hooks or exact cached replays carry resolution proof.
    claudeSettledRequests:
      source === 'claude' &&
      (envelope.isReplay === true ||
        hookEventName === 'PostToolBatch' ||
        hookEventName === 'PostToolUse' ||
        hookEventName === 'PostToolUseFailure')
        ? readClaudeSettledRequests(envelope.claudeSettledRequests)
        : undefined,
    toolAgentId:
      typeof hook.toolAgentId === 'string' && hook.toolAgentId.trim().length > 0
        ? hook.toolAgentId.trim()
        : undefined,
    teammateName:
      typeof envelope.teammateName === 'string' && envelope.teammateName.trim().length > 0
        ? envelope.teammateName.trim()
        : undefined,
    toolAgentType:
      typeof hook.toolAgentType === 'string' && hook.toolAgentType.trim().length > 0
        ? hook.toolAgentType.trim()
        : undefined,
    providerSession: normalizeAgentProviderSession(envelope.providerSession) ?? undefined
  }
}
