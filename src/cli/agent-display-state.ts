import {
  resolveAgentPaneDisplayState,
  resolveAgentWorktreeDisplayStatus,
  type AgentStatusDisplayState
} from '../shared/agent-status-display-state'
import { isFreshNonDoneAgentStatus } from '../shared/agent-status-freshness'
import { isAgentStatusState, type AgentMainAgentStatus } from '../shared/agent-status-types'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../shared/runtime-types'

type WireAgentRow = {
  state: string
  workingMode?: RuntimeWorktreeAgentRow['workingMode']
  interrupted?: boolean
  mainAgent?: AgentMainAgentStatus
}

/** What Orca shows for a row another build published. A state arm this build does not know
 *  degrades to absent: a `mainAgent` falls back to the row's own state, a row shows nothing. */
export function wireAgentDisplayState(
  row: WireAgentRow,
  decayedTo?: 'idle' | 'unverifiable'
): AgentStatusDisplayState | undefined {
  if (!isAgentStatusState(row.state)) {
    return undefined
  }
  const mainAgent =
    row.mainAgent && isAgentStatusState(row.mainAgent.state) ? row.mainAgent : undefined
  return resolveAgentPaneDisplayState(
    {
      state: row.state,
      workingMode: row.workingMode,
      interrupted: row.interrupted,
      ...(mainAgent ? { mainAgent } : {})
    },
    decayedTo
  )
}

export type DisplayedWorktreeAgentRow = RuntimeWorktreeAgentRow & {
  displayState?: AgentStatusDisplayState
}

export type DisplayedWorktreePsSummary = Omit<RuntimeWorktreePsSummary, 'agents'> & {
  displayStatus: RuntimeWorktreePsSummary['status'] | 'failed'
  agents: DisplayedWorktreeAgentRow[]
}

export type WithWorktreePsDisplayStatus<
  TResult extends Pick<RuntimeWorktreePsResult, 'worktrees'>
> = Omit<TResult, 'worktrees'> & { worktrees: DisplayedWorktreePsSummary[] }

/** CLI-computed presentation beside the host's lifecycle `status`, which stays as sent. */
export function withWorktreePsDisplayStatus<
  TResult extends Pick<RuntimeWorktreePsResult, 'worktrees'>
>(result: TResult, now = Date.now()): WithWorktreePsDisplayStatus<TResult> {
  return {
    ...result,
    worktrees: result.worktrees.map((worktree) => {
      let hasHumanWait = false
      let hasFailed = false
      const agents = worktree.agents.map((row): DisplayedWorktreeAgentRow => {
        // Why: decay live rows exactly where the host rollup stops counting them.
        const decayedTo =
          row.state !== 'done' && !isFreshNonDoneAgentStatus(row, now) ? 'idle' : undefined
        const displayState = wireAgentDisplayState(row, decayedTo)
        hasHumanWait ||= displayState === 'waiting' || displayState === 'blocked'
        hasFailed ||= displayState === 'failed'
        return displayState ? { ...row, displayState } : row
      })
      return {
        ...worktree,
        agents,
        displayStatus: resolveAgentWorktreeDisplayStatus({
          base: worktree.status,
          hasHumanWait,
          hasFailed
        })
      }
    })
  }
}
