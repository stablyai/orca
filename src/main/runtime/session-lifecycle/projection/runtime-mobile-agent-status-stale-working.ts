import {
  normalizeCompatibleAgentStatusEntryForOwner,
  type CompatibleAgentOwnerOptions
} from '../../../../shared/agent-status/title/agent-title-owner'
import { agentStatusAuthorityObservedAt } from '../../../../shared/agent-status/contracts/agent-status-freshness'
import type {
  AgentStatusEntry,
  AgentType
} from '../../../../shared/agent-status/contracts/agent-status-types'
import type { RuntimePtyWorktreeRecord } from '../../terminal/records/runtime-terminal-state-records'
import type { HookLiveAgentRow } from '../../workspaces/process-listing/hook-live-agent-row'
import { staleWorkingHookHoldsLiveChildren } from './runtime-mobile-agent-status-evidence'
import type { RuntimeHookAgentRowLookup } from './runtime-mobile-agent-status-projection'

export type StaleWorkingAgentStatusContext = {
  stale: HookLiveAgentRow
  paneKey: string
  terminalHandle: string | null
  terminalTitle: string
  tabId: string
  /** The pane record's attribution wins over the row's when both exist. */
  worktreeId: string | undefined
  providerSession: Partial<Pick<AgentStatusEntry, 'providerSession' | 'orcaSessionId'>>
  ownerAgent: AgentType | null
  ownerOptions: CompatibleAgentOwnerOptions
}

/**
 * Publish the stale-but-children-live row as unverifiable, keeping the children roster
 * (#46585). Clients keep identity and render no live status; the children's own evidence
 * keeps decaying under the existing rules.
 */
export function buildStaleWorkingAgentStatusEntry(
  context: StaleWorkingAgentStatusContext
): { agentStatus: AgentStatusEntry } {
  const { stale, ownerAgent } = context
  const agentType = ownerAgent ?? stale.payload.agentType
  const worktreeId = context.worktreeId ?? stale.worktreeId
  return {
    agentStatus: normalizeCompatibleAgentStatusEntryForOwner(
      {
        state: stale.payload.state,
        prompt: stale.payload.prompt,
        updatedAt: stale.updatedAt,
        stateStartedAt: stale.stateStartedAt,
        restoredUnconfirmed: true,
        ...(stale.payload.subagents !== undefined ? { subagents: stale.payload.subagents } : {}),
        paneKey: context.paneKey,
        ...(context.terminalHandle ? { terminalHandle: context.terminalHandle } : {}),
        ...(agentType ? { agentType } : {}),
        ...(worktreeId ? { worktreeId } : {}),
        tabId: context.tabId,
        terminalTitle: context.terminalTitle,
        stateHistory: [],
        ...context.providerSession
      },
      ownerAgent,
      context.ownerOptions
    )
  }
}

/** Everything the builder would otherwise inline for the stale-but-held row (#46585). */
export type HeldStaleWorkingRowContext = {
  hookRow: RuntimeHookAgentRowLookup
  pty: RuntimePtyWorktreeRecord | null
  paneKey: string
  terminalHandle: string | null
  terminalTitle: string
  tabId: string
  providerSession: Partial<Pick<AgentStatusEntry, 'providerSession' | 'orcaSessionId'>>
  ownerAgent: AgentType | null
  ownerOptions: CompatibleAgentOwnerOptions
}

/**
 * Silence never upgrades a working row with live children to done (#46585). Returns the
 * unverifiable entry (children retained) when the stale row holds, or null so the caller
 * keeps its existing paths.
 */
export function maybeBuildHeldStaleWorkingAgentStatus(
  context: HeldStaleWorkingRowContext
): { agentStatus: AgentStatusEntry } | null {
  const stale = context.hookRow.staleWorking
  if (
    !stale ||
    !staleWorkingHookHoldsLiveChildren(
      stale.payload,
      agentStatusAuthorityObservedAt(stale),
      context.pty
    )
  ) {
    return null
  }
  return buildStaleWorkingAgentStatusEntry({
    stale,
    paneKey: context.paneKey,
    terminalHandle: context.terminalHandle,
    terminalTitle: context.terminalTitle,
    tabId: context.tabId,
    worktreeId: context.pty?.worktreeId,
    providerSession: context.providerSession,
    ownerAgent: context.ownerAgent,
    ownerOptions: context.ownerOptions
  })
}
