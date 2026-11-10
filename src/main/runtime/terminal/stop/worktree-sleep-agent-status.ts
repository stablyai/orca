import { agentEvidencePredatesProcess } from '../../session-lifecycle/projection/runtime-agent-process-evidence'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { AgentStatusIpcPayload } from '../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import type { RuntimeMobileSessionTerminalTab } from '../../../../shared/runtime-mobile-session-tab-contracts'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session/workspace-session-state-types'
import { parsePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export function readWorktreeSleepAgentStatus(args: {
  paneKey: string
  pty: RuntimePtyWorktreeRecord | undefined
  processStartedAt?: number | null
  session: WorkspaceSessionState | null | undefined
  getRows: (paneKey: string) => AgentStatusIpcPayload[]
  build: (
    pty: RuntimePtyWorktreeRecord,
    tab: RuntimeMobileSessionTerminalTab,
    rows: (key: string) => AgentStatusIpcPayload[]
  ) => AgentStatusEntry | undefined
}): AgentStatusEntry | null {
  const { paneKey, pty } = args
  const pane = parsePaneKey(paneKey)
  const savedTab =
    pane &&
    pty &&
    args.session?.tabsByWorktree[pty.worktreeId]?.find((tab) => tab.id === pane.tabId)
  if (!pane || !pty || !savedTab) {
    return null
  }
  const tab: RuntimeMobileSessionTerminalTab = {
    type: 'terminal',
    id: paneKey,
    title: savedTab.title ?? '',
    parentTabId: pane.tabId,
    leafId: pane.leafId,
    isActive: false,
    launchAgent: savedTab.launchAgent
  }
  const accepted = args.getRows(paneKey).filter((row) => !row.providerSessionOnly)
  const latest = accepted.reduce<AgentStatusIpcPayload | undefined>(
    (best, row) => (!best || row.receivedAt > best.receivedAt ? row : best),
    undefined
  )
  // Accepted pane facts remain authoritative while its process lives, regardless of hook age.
  if (latest) {
    if (
      agentEvidencePredatesProcess(
        args.processStartedAt,
        latest.evidenceObservedAt ?? latest.receivedAt,
        Boolean(pty.lastAgentStatus)
      )
    ) {
      return null
    }
    return {
      ...latest,
      updatedAt: latest.receivedAt,
      stateHistory: latest.previousCompletion ? [latest.previousCompletion.end] : [],
      lastCompletedAssistantMessage: latest.previousCompletion?.lastAssistantMessage
    }
  }
  const entry = args.build(pty, tab, () => accepted)
  if (!entry || entry.restoredUnconfirmed) {
    return null
  }
  const clocks = [
    pty.lastAgentStatusStartedAtEpochMs,
    pty.lastOscTitleEpochMs,
    pty.titleObservedAtEpochMs
  ]
  return clocks.includes(entry.stateStartedAt) ? entry : null
}
