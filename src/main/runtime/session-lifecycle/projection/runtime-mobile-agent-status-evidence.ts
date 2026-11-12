import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

import { terminalTitleBlocksExplicitAgentStatus } from '../../workspaces/process-listing/runtime-worktree-status-projection'

import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

export type HookTurnFacts = Pick<
  AgentStatusEntry,
  'state' | 'agentType' | 'mainAgent' | 'restoredUnconfirmed'
>

export function workingHookOwnsIdleTitleInterval(
  status: HookTurnFacts,
  observedAt: number,
  pty: RuntimePtyWorktreeRecord | null
): boolean {
  return (
    status.state === 'working' &&
    pty?.lastAgentStatus === 'idle' &&
    !terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle) &&
    (codexHookReportsRunningTurn(status, observedAt, pty) ||
      observedAt >
        Math.max(
          pty.lastAgentStatusRichInvalidatedAtEpochMs ?? 0,
          pty.lastAgentStatusStartedAtEpochMs ?? 0
        )) &&
    Date.now() - observedAt <= AGENT_STATUS_STALE_AFTER_MS
  )
}

export function codexHookReportsRunningTurn(
  status: HookTurnFacts,
  observedAt: number,
  pty: RuntimePtyWorktreeRecord | null
): boolean {
  const mainState = status.mainAgent?.state
  return (
    status.agentType === 'codex' &&
    status.restoredUnconfirmed !== true &&
    mainState !== undefined &&
    mainState !== 'done' &&
    observedAt > (pty?.providerGenerationResetAtEpochMs ?? 0)
  )
}

export function completedTurnFields(
  status: AgentStatusEntry
): Pick<
  AgentStatusEntry,
  'lastAssistantMessage' | 'lastAssistantMessageIsToolOutput' | 'interrupted'
> {
  if (status.state !== 'done') {
    return {}
  }
  return {
    ...(status.lastAssistantMessage
      ? {
          lastAssistantMessage: status.lastAssistantMessage,
          ...(status.lastAssistantMessageIsToolOutput != null
            ? { lastAssistantMessageIsToolOutput: status.lastAssistantMessageIsToolOutput }
            : {})
        }
      : {}),
    ...(status.interrupted != null ? { interrupted: status.interrupted } : {})
  }
}

export function ptyStatusEvidenceAt(
  pty: RuntimePtyWorktreeRecord,
  titleEvidenceAt: number
): number {
  return Math.max(titleEvidenceAt, pty.lastAgentStatusStartedAtEpochMs ?? 0)
}

export function demoteRuntimeMobileAgentStatus(
  status: AgentStatusEntry,
  pty: RuntimePtyWorktreeRecord | null
): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    // A demotion supersedes the status it replaces, so it must never sort behind it.
    updatedAt:
      pty?.lastOscTitleEpochMs != null
        ? Math.max(status.updatedAt, ptyStatusEvidenceAt(pty, pty.lastOscTitleEpochMs))
        : status.updatedAt,
    stateStartedAt: pty?.lastAgentStatusStartedAtEpochMs ?? status.stateStartedAt,
    paneKey: status.paneKey,
    stateHistory: [],
    agentType: status.agentType,
    ...completedTurnFields(status),
    ...(status.providerSession ? { providerSession: status.providerSession } : {})
  }
}
