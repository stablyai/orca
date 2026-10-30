import { parseExecutionHostId } from '../../../src/shared/execution-host'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { agentDotState, type AgentDotState } from '../worktree/agent-row-display'
import type { Worktree } from '../worktree/workspace-list-types'
import { sanitizeStatusText } from './live-agent-status-text'
import type { LiveAgent, LiveNeed, LivePhase } from './live-alert-types'

/** The last good worktree.ps rows of one connected host. */
export type LiveHostRows = {
  hostId: string
  hostName: string
  worktrees: readonly Worktree[]
}

// Claude's question tool waits on an answer, not on a permission.
const QUESTION_TOOLS = new Set(['askuserquestion', 'ask_user_question', 'question'])

/**
 * The notification phase of a desktop dot state. Monitoring (background tasks only), idle and
 * unverifiable (no recent update) agents are left out: each would pin the notification while
 * nothing needs the user.
 */
export function livePhaseForDot(dot: AgentDotState): LivePhase | null {
  switch (dot) {
    case 'working':
      return 'working'
    case 'blocked':
    case 'waiting':
      return 'waiting'
    case 'done':
    case 'unconfirmed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'interrupted':
      return 'stopped'
    case 'monitoring':
    case 'idle':
    case 'unverifiable':
      return null
  }
}

export function isActiveLiveAgent(agent: Pick<LiveAgent, 'phase'>): boolean {
  return agent.phase === 'working' || agent.phase === 'waiting'
}

export function liveAgentKey(hostId: string, paneKey: string): string {
  return JSON.stringify([hostId, paneKey])
}

function needOf(row: RuntimeWorktreeAgentRow): LiveNeed {
  const tool = row.toolName?.trim().toLowerCase()
  return tool && !QUESTION_TOOLS.has(tool) ? 'approval' : 'input'
}

function toLiveAgent(
  host: LiveHostRows,
  worktree: Worktree,
  row: RuntimeWorktreeAgentRow,
  now: number
): LiveAgent | null {
  // agentDotState applies verdict marks and the 30-minute freshness decay, as the desktop does.
  const phase = livePhaseForDot(agentDotState(row, now))
  if (!phase) {
    return null
  }
  const executionHost = parseExecutionHostId(worktree.hostId)
  const workspace = sanitizeStatusText(worktree.displayName) || sanitizeStatusText(worktree.branch)
  return {
    key: liveAgentKey(host.hostId, row.paneKey),
    hostId: host.hostId,
    hostName: host.hostName,
    worktreeId: worktree.worktreeId,
    workspace: workspace || 'Workspace',
    executionHost: executionHost?.kind === 'runtime' ? executionHost.id : null,
    paneKey: row.paneKey,
    phase,
    need: phase === 'waiting' ? needOf(row) : null,
    agentType: row.agentType,
    prompt: row.prompt,
    lastAssistantMessage: row.lastAssistantMessage,
    toolName: row.toolName,
    toolInput: row.toolInput,
    stateStartedAt: row.stateStartedAt,
    updatedAt: row.updatedAt
  }
}

/** Every agent row of every unarchived worktree on the given hosts that the notification shows. */
export function collectLiveAgents(hosts: readonly LiveHostRows[], now: number): LiveAgent[] {
  const agents: LiveAgent[] = []
  for (const host of hosts) {
    for (const worktree of host.worktrees) {
      if (worktree.isArchived) {
        continue
      }
      for (const row of worktree.agents ?? []) {
        const agent = toLiveAgent(host, worktree, row, now)
        if (agent) {
          agents.push(agent)
        }
      }
    }
  }
  return agents
}

/** The agent the notification is about: the longest-waiting one, else the latest-updated worker. */
export function primaryLiveAgent(agents: readonly LiveAgent[]): LiveAgent | null {
  let waiting: LiveAgent | null = null
  let working: LiveAgent | null = null
  for (const agent of agents) {
    if (agent.phase === 'waiting' && (!waiting || agent.stateStartedAt < waiting.stateStartedAt)) {
      waiting = agent
    }
    if (agent.phase === 'working' && (!working || agent.updatedAt > working.updatedAt)) {
      working = agent
    }
  }
  return waiting ?? working
}

/** The agent whose turn ended last, for the "Done" notification. */
export function lastFinishedAgent(agents: readonly LiveAgent[]): LiveAgent | null {
  let last: LiveAgent | null = null
  for (const agent of agents) {
    if (!isActiveLiveAgent(agent) && (!last || agent.stateStartedAt > last.stateStartedAt)) {
      last = agent
    }
  }
  return last
}
