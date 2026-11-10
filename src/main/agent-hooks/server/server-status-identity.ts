import { mainAgentState } from '../../../shared/agent-status/lifecycle/main-agent-status'
import { isNewTurnEvent } from '../../../shared/agent-hook-listener/provider-event-routing'
import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentKind } from '../../../shared/telemetry-events'
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
    ...(entry.previousCompletion ? { previousCompletion: entry.previousCompletion } : {}),
    ...(entry.turnStartedAt !== undefined ? { turnStartedAt: entry.turnStartedAt } : {}),
    ...pickHostTurnEnd(entry),
    ...(entry.providerSession ? { providerSession: entry.providerSession } : {}),
    ...(entry.providerSessionOnly ? { providerSessionOnly: true } : {}),
    ...(entry.promptInteractionKey ? { promptInteractionKey: entry.promptInteractionKey } : {}),
    ...(entry.restoredUnconfirmed ? { restoredUnconfirmed: true } : {}),
    ...(entry.observation ? { observation: entry.observation } : {}),
    ...(entry.structuredHost ? { structuredHost: entry.structuredHost } : {}),
    ...(entry.terminalHandle ? { terminalHandle: entry.terminalHandle } : {}),
    ...(entry.programStatus ? { programStatus: entry.programStatus } : {}),
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

/** Only live main-agent turn boundaries establish a start; replay and child events preserve it. */
export function resolveTurnStartedAt(
  previous: EnrichedAgentHookEventPayload | undefined,
  payload: AgentHookEventPayload,
  at: number
): number | undefined {
  if (
    payload.source !== undefined &&
    payload.toolAgentId === undefined &&
    payload.isReplay !== true &&
    payload.providerSessionOnly !== true &&
    isNewTurnEvent(payload.source, payload.hookEventName) &&
    !(
      payload.source === 'codex' &&
      payload.hookEventName === 'SessionStart' &&
      !payload.hasExplicitPrompt
    )
  ) {
    return payload.payload.sessionBoundary === true ? undefined : at
  }
  // An undated return to work cannot inherit the completed turn's start.
  if (
    previous &&
    mainAgentState(previous.payload) === 'done' &&
    mainAgentState(payload.payload) !== 'done'
  ) {
    return undefined
  }
  return previous?.turnStartedAt
}
