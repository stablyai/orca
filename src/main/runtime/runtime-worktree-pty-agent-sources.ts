import {
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

export type ConnectedPtyEvidence = {
  tabIds: ReadonlySet<string>
  paneKeys: ReadonlySet<string>
  /** The connected PTY behind each issued terminal handle. A status row names a pane and the
   *  handle it was observed under, never a process, so this is where it rejoins its terminal —
   *  and it is the only rescue left for a row whose pane binding was cleared under it. */
  ptyIdByTerminalHandle: ReadonlyMap<string, string>
}

/** Admit hook-server rows using their execution-host evidence. */
export function collectRuntimeWorktreePtyAgentSources(args: {
  hookSnapshots: readonly AgentStatusIpcPayload[]
  mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  connectedPtyEvidence: ConnectedPtyEvidence
}): RuntimeWorktreeAgentSource[] {
  const rowSources = new Map<
    string,
    RuntimeWorktreeAgentSource & { payload: ParsedAgentStatusPayload }
  >()
  for (const entry of args.hookSnapshots) {
    if (entry.restoredUnconfirmed === true) {
      continue
    }
    const hookPayload = pickParsedAgentStatusPayload(entry)
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
      interrupted: entry.interrupted ?? false,
      stateStartedAt: entry.stateStartedAt,
      // A structured row's clock is its journal, so a restart's republish does not read as new.
      updatedAt: entry.structuredHost
        ? (entry.evidenceObservedAt ?? entry.receivedAt)
        : entry.receivedAt,
      ...(entry.structuredHost ? { structuredHost: entry.structuredHost } : {})
    })
  }
  const sources: RuntimeWorktreeAgentSource[] = []
  for (const source of rowSources.values()) {
    const tabId =
      source.tabId ??
      parsePaneKey(source.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(source.paneKey)?.tabId
    const mirroredWorktreeId = tabId ? args.mirroredWorktreeIdByTabId.get(tabId) : undefined
    // Why a structured row skips the connected-process gate: it has no PTY, and the host that
    // holds the session drops the row itself on close, so its presence is the liveness evidence.
    if (
      source.structuredHost === undefined &&
      tabId !== undefined &&
      mirroredWorktreeId === undefined &&
      (source.connectionId === null || isWslHookRelayConnectionId(source.connectionId)) &&
      !args.connectedPtyEvidence.tabIds.has(tabId) &&
      !args.connectedPtyEvidence.paneKeys.has(source.paneKey) &&
      // Resolved only from a connected PTY's handle, so its presence is the liveness evidence.
      source.ptyId === undefined
    ) {
      continue
    }
    const worktreeId = mirroredWorktreeId ?? source.worktreeId
    sources.push({ ...source, tabId, worktreeId })
  }
  return sources
}
