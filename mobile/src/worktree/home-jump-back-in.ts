import type { WorktreeStatus } from '../../../src/shared/worktree-status-rollup'
import type { ConnectionState } from '../transport/types'
import type { HomeResumeCard } from './home-resume-card'
import type {
  HomeAttentionWorktree,
  HomeWorktreeSummary,
  HostWorktreeInfo
} from './home-worktree-info'
import { getWorktreeDotStatus } from './workspace-list-ordering'

const ATTENTION_ROWS_PER_HOST = 6
const ATTENTION_ROWS_SHOWN = 3

// Lower comes first: agents blocked on the user, then finished work they haven't seen, then running work.
function attentionRank(dotStatus: WorktreeStatus, unread: boolean): number | null {
  if (dotStatus === 'permission' || dotStatus === 'failed') {
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

/** The rows of one desktop's list that "Jump back in" may show, using the workspace list's dot status. */
export function selectHomeAttentionWorktrees(
  rows: readonly HomeWorktreeSummary[]
): HomeAttentionWorktree[] {
  const ranked: (HomeAttentionWorktree & { rank: number })[] = []
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
      workingMode: row.workingMode
    })
  }
  return ranked
    .sort(byRankThenRecent)
    .slice(0, ATTENTION_ROWS_PER_HOST)
    .map(({ rank: _rank, ...worktree }) => worktree)
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
