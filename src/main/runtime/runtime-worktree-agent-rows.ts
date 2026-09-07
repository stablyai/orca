import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { terminalStatusPayloadMatchesHook } from '../../shared/agent-terminal-status-equivalence'
import type { RuntimeWorktreeAgentRow, RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { isWslHookRelayConnectionId } from '../../shared/wsl-hook-relay-contract'
import { mergeWorktreeSummaryStatus } from './runtime-worktree-status-projection'
import type { RuntimeWorktreeSummaryPathIndex } from './runtime-worktree-summary-paths'
import type { RuntimeWorkingTerminalEvidence } from './runtime-worktree-ps-activity'

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

type ConnectedPtyEvidence = {
  tabIds: ReadonlySet<string>
  paneKeys: ReadonlySet<string>
  ptyIds: ReadonlySet<string>
}

type OrchestrationDisplay = {
  taskTitle?: string | null
  displayName?: string | null
  parentPaneKey?: string | null
}

type RuntimeWorktreeAgentSource = {
  paneKey: string
  ptyId?: string
  tabId?: string
  worktreeId?: string
  connectionId: string | null
  payload: ParsedAgentStatusPayload
  state: ParsedAgentStatusPayload['state']
  workingMode?: ParsedAgentStatusPayload['workingMode']
  agentType: string | null
  prompt: string
  lastAssistantMessage: string | null
  toolName: string | null
  toolInput: string | null
  interrupted: boolean
  stateStartedAt: number
  updatedAt: number
  restoredUnconfirmed?: boolean
}

export function attachRuntimeWorktreeAgentRows(args: {
  summaries: Map<string, RuntimeWorktreePsSummary>
  pathIndex: RuntimeWorktreeSummaryPathIndex
  missingWorktreeIds: Set<string>
  mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  connectedPtyEvidence: ConnectedPtyEvidence
  workingTerminalEvidenceByWorktreeId: ReadonlyMap<
    string,
    readonly RuntimeWorkingTerminalEvidence[]
  >
  retainedSnapshots: Iterable<RuntimeAgentRowSnapshot>
  hookSnapshots: readonly AgentStatusIpcPayload[]
  orchestrationByPaneKey: Record<string, OrchestrationDisplay> | null | undefined
  getSummary: (
    summaries: Map<string, RuntimeWorktreePsSummary>,
    pathIndex: RuntimeWorktreeSummaryPathIndex,
    missingWorktreeIds: Set<string>,
    worktreeId: string
  ) => RuntimeWorktreePsSummary | null
}): void {
  const rowSources = new Map<string, RuntimeWorktreeAgentSource>()
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
  if (rowSources.size === 0) {
    return
  }
  const rowsByWorktree = new Map<string, RuntimeWorktreeAgentRow[]>()
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
    if (!worktreeId) {
      continue
    }
    const summary = args.getSummary(
      args.summaries,
      args.pathIndex,
      args.missingWorktreeIds,
      worktreeId
    )
    if (!summary) {
      continue
    }
    const orchestration = args.orchestrationByPaneKey?.[source.paneKey]
    const row: RuntimeWorktreeAgentRow = {
      paneKey: source.paneKey,
      parentPaneKey: orchestration?.parentPaneKey ?? null,
      state: source.state,
      ...(source.workingMode ? { workingMode: source.workingMode } : {}),
      agentType: source.agentType,
      prompt: source.prompt,
      taskTitle: orchestration?.taskTitle ?? null,
      displayName: orchestration?.displayName ?? null,
      lastAssistantMessage: source.lastAssistantMessage,
      toolName: source.toolName,
      toolInput: source.toolInput,
      interrupted: source.interrupted,
      stateStartedAt: source.stateStartedAt,
      updatedAt: source.updatedAt
    }
    const rows = rowsByWorktree.get(summary.worktreeId)
    if (rows) {
      rows.push(row)
    } else {
      rowsByWorktree.set(summary.worktreeId, [row])
    }
  }
  for (const [worktreeId, rows] of rowsByWorktree) {
    rows.sort((a, b) => a.stateStartedAt - b.stateStartedAt)
    const summary = args.summaries.get(worktreeId)
    if (!summary) {
      continue
    }
    summary.agents = rows
    let hasForegroundWorkingAgent = false
    const monitoringSources: RuntimeWorktreeAgentSource[] = []
    for (const row of rows) {
      if (!isFreshNonDoneAgentStatus(row, now)) {
        continue
      }
      summary.hasHostSidebarActivity = true
      if (row.state === 'working') {
        if (row.workingMode === 'monitoring') {
          const source = rowSources.get(row.paneKey)
          if (source) {
            monitoringSources.push(source)
          }
        } else {
          hasForegroundWorkingAgent = true
        }
      } else {
        mergeWorktreeSummaryStatus(summary, 'permission')
      }
    }
    if (hasForegroundWorkingAgent || monitoringSources.length > 0) {
      const hasIndependentWorkingTerminal = (
        args.workingTerminalEvidenceByWorktreeId.get(worktreeId) ?? []
      ).some((evidence) =>
        monitoringSources.every((source) => !workingTerminalEvidenceMatchesSource(evidence, source))
      )
      mergeWorktreeSummaryStatus(
        summary,
        'working',
        hasForegroundWorkingAgent || hasIndependentWorkingTerminal ? undefined : 'monitoring'
      )
    }
  }
}

function workingTerminalEvidenceMatchesSource(
  evidence: RuntimeWorkingTerminalEvidence,
  source: RuntimeWorktreeAgentSource
): boolean {
  if (evidence.paneKey) {
    return (
      evidence.paneKey === source.paneKey ||
      Boolean(evidence.ptyId && source.ptyId && evidence.ptyId === source.ptyId)
    )
  }
  if (evidence.ptyId && source.ptyId) {
    return evidence.ptyId === source.ptyId
  }
  return Boolean(evidence.tabId && evidence.tabId === source.tabId)
}
