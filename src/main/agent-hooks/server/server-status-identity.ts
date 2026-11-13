import type { AgentKind } from '../../../shared/telemetry-events'
import {
  isSameAgentProcess,
  type AgentProcessIdentity
} from '../../../shared/agent-status/process/agent-process-presence'
import { readNativeChatPromptDigest } from '../../../shared/native-chat/input/native-chat-prompt-observation'
import { publishedOrcaSessionId } from '../identity/pane-agent-identities'
import { getAgentResumeArgv } from '../../../shared/agent-launch/startup/agent-resume-argv'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  parseLegacyNumericPaneKey,
  parsePaneKey
} from '../../../shared/workspace-layout/stable-pane-id'
import {
  pickHostTurnEnd,
  type AgentType
} from '../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { EnrichedAgentHookEventPayload } from './server-types'
import { AGENT_PROMPT_SENT_AGENT_KINDS } from './server-constants'
import { MAX_PANE_KEY_LEN } from '../../../shared/agent-hook-listener/listener-limits'

export function agentTypeToPromptSentAgentKind(agentType: AgentType | undefined): AgentKind {
  const normalized = agentType?.trim().toLowerCase()
  if (!normalized || normalized === 'unknown') {
    return 'other'
  }
  if (normalized === 'claude') {
    return 'claude-code'
  }
  return AGENT_PROMPT_SENT_AGENT_KINDS.has(normalized as AgentKind)
    ? (normalized as AgentKind)
    : 'other'
}

export function equivalentInterruptAgentType(
  actual: AgentType | undefined,
  baseline: AgentType | undefined
): boolean {
  const normalizedActual = actual === 'unknown' ? undefined : actual
  const normalizedBaseline = baseline === 'unknown' ? undefined : baseline
  return normalizedActual === normalizedBaseline
}

// Durable caches reject legacy numeric keys; only stable pane IDs survive restart.
export function isValidPaneKey(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= MAX_PANE_KEY_LEN && parsePaneKey(value) !== null
  )
}

// Remote identity-only rows are a Pi contract; dismissed rows use a separate retained marker.
export function isValidPiProviderSessionOnly(
  providerSession: AgentProviderSessionMetadata | undefined,
  agentType: AgentType | undefined
): boolean {
  return Boolean(providerSession && agentType === 'pi' && getAgentResumeArgv('pi', providerSession))
}

export function toAgentStatusIpcPayload(
  entry: EnrichedAgentHookEventPayload
): AgentStatusIpcPayload {
  return {
    paneKey: entry.paneKey,
    ...(entry.launchToken ? { launchToken: entry.launchToken } : {}),
    tabId: entry.tabId,
    worktreeId: entry.worktreeId,
    connectionId: entry.connectionId,
    receivedAt: entry.receivedAt,
    ...(entry.evidenceObservedAt !== undefined
      ? { evidenceObservedAt: entry.evidenceObservedAt }
      : {}),
    stateStartedAt: entry.stateStartedAt,
    ...(entry.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}),
    ...pickHostTurnEnd(entry),
    ...(entry.providerSession ? { providerSession: entry.providerSession } : {}),
    ...(entry.providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...(entry.promptInteractionKey ? { promptInteractionKey: entry.promptInteractionKey } : {}),
    ...(entry.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    ...(entry.observation ? { observation: entry.observation } : {}),
    ...(entry.promptSubmissions ? { promptSubmissions: entry.promptSubmissions } : {}),
    ...(entry.structuredHost ? { structuredHost: entry.structuredHost } : {}),
    ...(entry.terminalHandle ? { terminalHandle: entry.terminalHandle } : {}),
    ...(entry.programStatus ? { programStatus: entry.programStatus } : {}),
    ...(publishedOrcaSessionId(entry.agentIdentity) !== undefined
      ? { orcaSessionId: publishedOrcaSessionId(entry.agentIdentity) }
      : {}),
    ...entry.payload
  }
}

export function paneCacheKeyTabId(key: string): string | null {
  const paneKey = key.split('\0', 1)[0] ?? key
  return parsePaneKey(paneKey)?.tabId ?? parseLegacyNumericPaneKey(paneKey)?.tabId ?? null
}

export function paneCacheKeyMatchesTab(key: string, tabId: string): boolean {
  return paneCacheKeyTabId(key) === tabId
}

export function retainNativeChatPromptSubmissions(
  current: EnrichedAgentHookEventPayload,
  previous: EnrichedAgentHookEventPayload | undefined,
  candidate?: string,
  sender?: AgentProcessIdentity
): EnrichedAgentHookEventPayload {
  const { promptSubmissions: _oldHistory, ...row } = current
  const presence = current.agentPresence
  const process = presence?.process
  const observation = current.observation
  const sessionId = current.providerSession?.id
  if (
    !process ||
    !observation ||
    !sessionId ||
    !presence.sessionOwner ||
    presence.ended ||
    presence.fallback ||
    presence.suspended ||
    current.structuredHost ||
    current.providerSessionOnly
  ) {
    return row
  }
  const retained = previous?.promptSubmissions
  const filtered = retained?.filter(
    (entry) =>
      entry.sessionId === sessionId &&
      entry.connectionId === current.connectionId &&
      isSameAgentProcess(entry.process, process) &&
      entry.observation.authorityId === observation.authorityId &&
      entry.observation.incarnation === observation.incarnation
  )
  const history = filtered?.length === retained?.length ? retained : filtered
  const textDigest =
    sender && isSameAgentProcess(sender, process)
      ? readNativeChatPromptDigest(candidate)
      : undefined
  const next =
    textDigest && !current.toolAgentId
      ? [
          ...(history ?? []),
          { process, observation, sessionId, connectionId: current.connectionId, textDigest }
        ].slice(-8)
      : history
  return next?.length ? { ...row, promptSubmissions: next } : row
}
