import { isAgentStatusFresh } from '../../../src/shared/agent-status/contracts/agent-status-freshness'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import {
  applyAgentPaneActivityFlags,
  createAgentPaneActivityFlags,
  rankWorktreeStatus,
  type WorktreeStatus
} from '../../../src/shared/worktree-status-rollup'
import type { ConnectionState } from '../transport/connection/connection-state'
import type { HomeResumeCard } from './home-resume-card'
import type {
  HomeAttentionWorktree,
  HomeWorktreeSummary,
  HostWorktreeInfo
} from './home-worktree-info'
import { buildAgentRowLineageTree } from './agent-row-lineage'
import { getWorktreeDotStatus } from './workspace-list-ordering'

// Feed shows the first few and "Show all" the rest; the bound keeps a busy desktop's list small.
const ATTENTION_ROWS_PER_HOST = 25
const ATTENTION_ROWS_SHOWN = 25

/** Agents blocked on the user: they rank first, badge the Feed tab and are counted per desktop. */
export function homeAgentNeedsYou(dotStatus: WorktreeStatus): boolean {
  return dotStatus === 'permission' || dotStatus === 'failed'
}

// Lower comes first: agents blocked on the user, then finished work they haven't seen, then running work.
function attentionRank(dotStatus: WorktreeStatus, unread: boolean): number | null {
  if (homeAgentNeedsYou(dotStatus)) {
    return 0
  }
  if (dotStatus === 'done' && unread) {
    return 1
  }
  if (dotStatus === 'working' || dotStatus === 'monitoring') {
    return 2
  }
  return null
}

function byRankThenRecent(
  a: { rank: number; lastOutputAt?: number },
  b: { rank: number; lastOutputAt?: number }
): number {
  return a.rank - b.rank || (b.lastOutputAt ?? 0) - (a.lastOutputAt ?? 0)
}

function agentDotStatus(agent: RuntimeWorktreeAgentRow): WorktreeStatus {
  const flags = createAgentPaneActivityFlags()
  applyAgentPaneActivityFlags(flags, agent)
  return rankWorktreeStatus('inactive', flags)
}

// The newest top-level agent the host counted in the dot's state names the row; a nameless one keeps the workspace title.
function conversationBehindDot(
  agents: readonly RuntimeWorktreeAgentRow[] | undefined,
  dotStatus: WorktreeStatus,
  now: number
): Pick<HomeAttentionWorktree, 'conversationName' | 'paneKey'> {
  let newest: RuntimeWorktreeAgentRow | undefined
  for (const agent of buildAgentRowLineageTree(agents ?? []).rootRows) {
    if (
      isAgentStatusFresh(agent, now) &&
      agentDotStatus(agent) === dotStatus &&
      (!newest || agent.updatedAt > newest.updatedAt)
    ) {
      newest = agent
    }
  }
  const conversationName = newest?.conversationName?.trim()
  return newest && conversationName ? { conversationName, paneKey: newest.paneKey } : {}
}

/** The rows of one desktop's list that "Jump back in" may show, using the workspace list's dot status. */
export function selectHomeAttentionWorktrees(
  rows: readonly HomeWorktreeSummary[]
): HomeAttentionWorktree[] {
  const now = Date.now()
  const ranked: (HomeAttentionWorktree & Pick<HomeWorktreeSummary, 'agents'> & { rank: number })[] =
    []
  for (const row of rows) {
    if (row.isArchived === true) {
      continue
    }
    const dotStatus = getWorktreeDotStatus(row)
    const rank = attentionRank(dotStatus, row.unread === true)
    if (rank === null) {
      continue
    }
    ranked.push({
      rank,
      dotStatus,
      worktreeId: row.worktreeId,
      repo: row.repo,
      branch: row.branch,
      displayName: row.displayName,
      lastOutputAt: typeof row.lastOutputAt === 'number' ? row.lastOutputAt : undefined,
      workingMode: row.workingMode,
      agents: row.agents
    })
  }
  return ranked
    .sort(byRankThenRecent)
    .slice(0, ATTENTION_ROWS_PER_HOST)
    .map(({ rank: _rank, agents, ...worktree }) => ({
      ...worktree,
      ...conversationBehindDot(agents, worktree.dotStatus, now)
    }))
}

export type HomeJumpBackInRow = Readonly<{
  hostId: string
  worktree: HomeAttentionWorktree
  /** The resume target rather than an agent that needs the user. */
  lastOpened: boolean
  actionable: boolean
}>

export function selectHomeJumpBackInRows(input: {
  hosts: readonly { id: string }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
  resumeCard: HomeResumeCard | null
}): HomeJumpBackInRow[] {
  const candidates: (HomeJumpBackInRow & { rank: number; lastOutputAt?: number })[] = []
  for (const host of input.hosts) {
    const info = input.worktreeInfo[host.id]
    // Agent states are shown only from a connected desktop's list read this session.
    if (input.hostStates[host.id] !== 'connected' || !info?.attention || info.catalogUnavailable) {
      continue
    }
    for (const worktree of info.attention) {
      candidates.push({
        hostId: host.id,
        worktree,
        lastOpened: false,
        actionable: true,
        rank: attentionRank(worktree.dotStatus, true) ?? 2,
        lastOutputAt: worktree.lastOutputAt
      })
    }
  }
  const rows: HomeJumpBackInRow[] = candidates
    .sort(byRankThenRecent)
    .slice(0, ATTENTION_ROWS_SHOWN)
    .map(({ rank: _rank, lastOutputAt: _lastOutputAt, ...row }) => row)
  const resume = input.resumeCard
  if (
    resume &&
    !rows.some(
      (row) =>
        row.hostId === resume.hostId && row.worktree.worktreeId === resume.worktree.worktreeId
    )
  ) {
    rows.push({
      hostId: resume.hostId,
      worktree: {
        worktreeId: resume.worktree.worktreeId,
        repo: resume.worktree.repo,
        branch: resume.worktree.branch,
        displayName: resume.worktree.displayName,
        lastOutputAt: resume.worktree.lastOutputAt,
        dotStatus: 'inactive'
      },
      lastOpened: true,
      actionable: resume.actionable
    })
  }
  return rows
}
