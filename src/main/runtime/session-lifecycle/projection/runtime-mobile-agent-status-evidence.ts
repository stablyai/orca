import {
  AGENT_STATUS_HELD_ROW_MAX_AGE_MS,
  AGENT_STATUS_STALE_AFTER_MS
} from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { foldMainAgentWithRowChildWork } from '../../../../shared/agent-hook-listener/state/agent-hook-row-child-work-fold'

import { terminalTitleBlocksExplicitAgentStatus } from '../../workspaces/process-listing/runtime-worktree-status-projection'

import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'

export type HookTurnFacts = Pick<
  AgentStatusEntry,
  'state' | 'agentType' | 'mainAgent' | 'restoredUnconfirmed' | 'subagents'
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
        ) ||
      rowChildWorkHoldsIdleLead(status, observedAt, pty)) &&
    Date.now() - observedAt <= AGENT_STATUS_STALE_AFTER_MS
  )
}

/**
 * Silence never upgrades a row to done (#46585). A quiet lead whose last hook row is
 * still `working` and whose children are still live keeps the row unverifiable past the
 * freshness window: the same children that hold the turn open inside the window hold it
 * open after it. Provider-neutral — the child fold is shared, and no provider-specific
 * branch is added here.
 *
 * The hold is bounded twice (#46585 review): past `AGENT_STATUS_HELD_ROW_MAX_AGE_MS` it
 * returns to the title-only path, and a provider generation reset (the agent was replaced
 * in the same PTY) invalidates older rows through `rowChildWorkHoldsIdleLead`. Stored
 * child states never age, so an unbounded hold could outlive the run it describes.
 */
export function staleWorkingHookHoldsLiveChildren(
  status: HookTurnFacts,
  observedAt: number,
  pty: RuntimePtyWorktreeRecord | null
): boolean {
  const age = Date.now() - observedAt
  return (
    status.state === 'working' &&
    pty?.lastAgentStatus === 'idle' &&
    !terminalTitleBlocksExplicitAgentStatus(pty.lastOscTitle) &&
    age > AGENT_STATUS_STALE_AFTER_MS &&
    age <= AGENT_STATUS_HELD_ROW_MAX_AGE_MS &&
    rowChildWorkHoldsIdleLead(status, observedAt, pty)
  )
}

/** An idle lead does not end a turn the row's live children hold open, whichever report landed first (#39120). */
function rowChildWorkHoldsIdleLead(
  status: HookTurnFacts,
  observedAt: number,
  pty: RuntimePtyWorktreeRecord
): boolean {
  return (
    status.restoredUnconfirmed !== true &&
    observedAt > (pty.providerGenerationResetAtEpochMs ?? 0) &&
    foldMainAgentWithRowChildWork('done', { payload: status }).stateName !== 'done'
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
  if (status.state === 'done') {
    const completedStatus = { ...status }
    delete completedStatus.terminalTitle
    return completedStatus
  }
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
    ...(status.providerSession ? { providerSession: status.providerSession } : {}),
    ...(status.orcaSessionId !== undefined ? { orcaSessionId: status.orcaSessionId } : {})
  }
}
