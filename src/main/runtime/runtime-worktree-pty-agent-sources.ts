import {
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { agentVerdictFields } from '../../shared/agent-main-agent-verdict'
import { isLocalHookConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

export type ConnectedPtyEvidence = {
  tabIds: ReadonlySet<string>
  paneKeys: ReadonlySet<string>
  /** Join status rows to connected PTYs by issued handle; this also rescues rows whose pane binding was cleared. */
  ptyIdByTerminalHandle: ReadonlyMap<string, string>
}

/** Join only the host-owned summary of this exact chat, never a remote pane with a similar id. */
function publishedStructuredChildren(
  entry: AgentStatusIpcPayload,
  read: ((sessionId: string) => AgentSessionStatusSummary | undefined) | undefined
) {
  const prefix = structuredAgentSessionTabId('')
  const tabId = entry.tabId
  if (!read || !entry.structuredHost || entry.connectionId !== null || !tabId?.startsWith(prefix)) {
    return undefined
  }
  const sessionId = tabId.slice(prefix.length)
  if (entry.paneKey !== structuredAgentSessionPaneKey(tabId, sessionId)) {
    return undefined
  }
  const summary = read(sessionId)
  return summary?.workspaceId === entry.worktreeId ? (summary?.children ?? []) : undefined
}

/** Admit hook-server rows using their execution-host evidence. */
export function collectRuntimeWorktreePtyAgentSources(args: {
  hookSnapshots: readonly AgentStatusIpcPayload[]
  readStructuredSummary?: (sessionId: string) => AgentSessionStatusSummary | undefined
  mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  connectedPtyEvidence: ConnectedPtyEvidence
}): RuntimeWorktreeAgentSource[] {
  const rowSources = new Map<
    string,
    RuntimeWorktreeAgentSource & { payload: ParsedAgentStatusPayload }
  >()
  for (const entry of args.hookSnapshots) {
    if (entry.restoredUnconfirmed === true || entry.providerSessionOnly === true) {
      continue
    }
    const hookPayload = pickParsedAgentStatusPayload(entry)
    const children = publishedStructuredChildren(entry, args.readStructuredSummary)
    rowSources.set(entry.paneKey, {
      paneKey: entry.paneKey,
      ptyId: entry.terminalHandle
        ? args.connectedPtyEvidence.ptyIdByTerminalHandle.get(entry.terminalHandle)
        : undefined,
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
      interrupted: false,
      ...agentVerdictFields(entry),
      stateStartedAt: entry.stateStartedAt,
      // A replay advances delivery order, not the age of the evidence shown by worktree.ps.
      updatedAt: entry.evidenceObservedAt ?? entry.receivedAt,
      ...(children !== undefined ? { children } : {}),
      ...(entry.subagents !== undefined ? { subagents: entry.subagents } : {}),
      ...(entry.structuredHost ? { structuredHost: entry.structuredHost } : {}),
      ...(entry.programStatus ? { programStatus: entry.programStatus } : {})
    })
  }
  const sources: RuntimeWorktreeAgentSource[] = []
  for (const source of rowSources.values()) {
    const tabId =
      source.tabId ??
      parsePaneKey(source.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(source.paneKey)?.tabId
    const mirroredWorktreeId = tabId ? args.mirroredWorktreeIdByTabId.get(tabId) : undefined
    const hasLivePty =
      // Resolved only from a connected PTY's handle, so its presence is the liveness evidence.
      source.ptyId !== undefined ||
      args.connectedPtyEvidence.paneKeys.has(source.paneKey) ||
      (tabId !== undefined && args.connectedPtyEvidence.tabIds.has(tabId))
    // Structured rows have no PTY; their host removes them on close, so roster membership proves liveness.
    if (
      source.structuredHost === undefined &&
      tabId !== undefined &&
      mirroredWorktreeId === undefined &&
      isLocalHookConnectionId(source.connectionId) &&
      !hasLivePty
    ) {
      continue
    }
    const worktreeId = mirroredWorktreeId ?? source.worktreeId
    sources.push({ ...source, tabId, worktreeId, ...(hasLivePty ? { hasLivePty: true } : {}) })
  }
  return sources
}
