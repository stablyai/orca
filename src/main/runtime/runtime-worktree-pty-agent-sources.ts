import {
  AGENT_STATUS_STALE_AFTER_MS,
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { terminalStatusPayloadMatchesHook } from '../../shared/agent-terminal-status-equivalence'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

export type RuntimeAgentRowSnapshot = {
  paneKey: string
  ptyId: string
  worktreeId?: string
  tabId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  stateStartedAt: number
  updatedAt: number
}

export type ConnectedPtyEvidence = {
  tabIds: ReadonlySet<string>
  paneKeys: ReadonlySet<string>
  ptyIds: ReadonlySet<string>
}

/** Reconcile terminal status, then admit rows using their execution-host evidence. */
export function collectRuntimeWorktreePtyAgentSources(args: {
  retainedSnapshots: Iterable<RuntimeAgentRowSnapshot>
  hookSnapshots: readonly AgentStatusIpcPayload[]
  mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  connectedPtyEvidence: ConnectedPtyEvidence
}): RuntimeWorktreeAgentSource[] {
  const rowSources = new Map<
    string,
    RuntimeWorktreeAgentSource & { payload: ParsedAgentStatusPayload }
  >()
  const now = Date.now()
  for (const snapshot of args.retainedSnapshots) {
    const { payload } = snapshot
    rowSources.set(snapshot.paneKey, {
      paneKey: snapshot.paneKey,
      ptyId: snapshot.ptyId,
      tabId: snapshot.tabId,
      worktreeId: snapshot.worktreeId,
      connectionId: snapshot.connectionId,
      payload,
      state: payload.state,
      ...(payload.workingMode ? { workingMode: payload.workingMode } : {}),
      agentType: payload.agentType ?? null,
      prompt: payload.prompt,
      lastAssistantMessage: payload.lastAssistantMessage ?? null,
      toolName: payload.toolName ?? null,
      toolInput: payload.toolInput ?? null,
      interrupted: payload.interrupted ?? false,
      stateStartedAt: snapshot.stateStartedAt,
      updatedAt: snapshot.updatedAt
    })
  }
  for (const entry of args.hookSnapshots) {
    if (entry.restoredUnconfirmed === true) {
      continue
    }
    const existing = rowSources.get(entry.paneKey)
    const hookPayload = pickParsedAgentStatusPayload(entry)
    if (existing && existing.updatedAt > entry.receivedAt) {
      if (
        entry.workingMode === 'monitoring' &&
        now - entry.receivedAt <= AGENT_STATUS_STALE_AFTER_MS &&
        terminalStatusPayloadMatchesHook(hookPayload, existing.payload)
      ) {
        existing.workingMode = 'monitoring'
        if (existing.payload.workingMode === undefined) {
          existing.payload = { ...existing.payload, workingMode: 'monitoring' }
        }
      }
      continue
    }
    rowSources.set(entry.paneKey, {
      paneKey: entry.paneKey,
      ptyId: existing?.ptyId,
      tabId: entry.tabId,
      worktreeId: entry.worktreeId,
      connectionId: entry.connectionId,
      payload: hookPayload,
      state: entry.state,
      ...(entry.workingMode ? { workingMode: entry.workingMode } : {}),
      agentType: entry.agentType ?? null,
      prompt: entry.prompt,
      lastAssistantMessage: entry.lastAssistantMessage ?? null,
      toolName: entry.toolName ?? null,
      toolInput: entry.toolInput ?? null,
      interrupted: entry.interrupted ?? false,
      stateStartedAt: entry.stateStartedAt,
      updatedAt: entry.receivedAt
    })
  }
  const sources: RuntimeWorktreeAgentSource[] = []
  for (const source of rowSources.values()) {
    const tabId =
      source.tabId ??
      parsePaneKey(source.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(source.paneKey)?.tabId
    const mirroredWorktreeId = tabId ? args.mirroredWorktreeIdByTabId.get(tabId) : undefined
    if (
      tabId !== undefined &&
      mirroredWorktreeId === undefined &&
      (source.connectionId === null || isWslHookRelayConnectionId(source.connectionId)) &&
      !args.connectedPtyEvidence.tabIds.has(tabId) &&
      !args.connectedPtyEvidence.paneKeys.has(source.paneKey) &&
      (source.ptyId === undefined || !args.connectedPtyEvidence.ptyIds.has(source.ptyId))
    ) {
      continue
    }
    const worktreeId = mirroredWorktreeId ?? source.worktreeId
    sources.push({ ...source, tabId, worktreeId })
  }
  return sources
}
