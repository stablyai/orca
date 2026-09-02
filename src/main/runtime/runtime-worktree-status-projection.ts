import {
  detectAgentStatusFromTitle,
  isClaudeManagementTitle,
  isOpenCodeNativeTitle,
  isQuarterCircleSpinnerOnlyAgentTitle,
  isShellProcess,
  type AgentStatus
} from '../../shared/agent-detection'
import type { AgentStatusEntry } from '../../shared/agent-status-types'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type {
  RuntimeTerminalAgentStatus,
  RuntimeWorktreePsSummary,
  RuntimeWorktreeStatus
} from '../../shared/runtime-types'
import type { TuiAgent } from '../../shared/tui-agent'

const WORKTREE_STATUS_PRIORITY: Record<RuntimeWorktreeStatus, number> = {
  inactive: 0,
  active: 1,
  done: 2,
  working: 3,
  permission: 4
}

type LeafStatusRecord = {
  ptyId: string | null
  paneTitle?: string | null
  paneTitleUpdatedAt: number | null
  lastOscTitle: string | null
  lastOscTitleAt: number | null
  lastAgentStatus: AgentStatus | null
}

type PtyTitleRecord = {
  title: string | null
  titleUpdatedAt: number | null
  lastOscTitle: string | null
  lastOscTitleAt: number | null
}

type PtyAgentPresenceRecord = {
  launchAgent: TuiAgent | null
  launchToken: string | null
  launchIncarnationId: PtyIncarnationId | null
  incarnationId: PtyIncarnationId | null
}

export function getLeafWorktreeStatus(
  leaf: LeafStatusRecord,
  tabTitle: string | null
): RuntimeWorktreeStatus {
  // Why: recompute from the live title each call (no sticky state) so worktree.ps mirrors the desktop sidebar's getWorktreeStatus.
  const titleCandidates = [
    { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
    { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt },
    { title: tabTitle, updatedAt: 0 }
  ]
  const latestTitle = getLatestAgentCandidateTitle(...titleCandidates)
  const detected = latestTitle ? detectAgentStatusFromTitle(latestTitle) : leaf.lastAgentStatus
  return getDetectedWorktreeStatus(detected, leaf.ptyId !== null)
}

export function classifyLatestAgentTitle(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): 'agent' | 'management' | 'neutral' {
  return classifyAgentTitle(getLatestAgentCandidateTitle(...titles))
}

export function getLatestPtyTitle(pty: PtyTitleRecord): string | null {
  return getLatestAgentCandidateTitle(
    { title: pty.title, updatedAt: pty.titleUpdatedAt },
    { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
  )
}

export function getLatestLeafTitle(
  leaf: Pick<
    LeafStatusRecord,
    'paneTitle' | 'paneTitleUpdatedAt' | 'lastOscTitle' | 'lastOscTitleAt'
  >,
  tabTitle: string | null
): string | null {
  return getLatestAgentCandidateTitle(
    { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
    { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt },
    { title: tabTitle, updatedAt: 0 }
  )
}

// Why: an 'agent' title only proves an agent owns the pane when something other than a
// quarter-circle spinner carries it — those glyphs are generic progress frames (STA-4028).
export function agentTitleProvesAgentPresence(
  title: string | null,
  classification: 'agent' | 'management' | 'neutral'
): boolean {
  return (
    classification === 'agent' &&
    !isOpenCodeNativeTitle(title) &&
    !isQuarterCircleSpinnerOnlyAgentTitle(title)
  )
}

export function ptyTitleProvesAgentPresence(
  pty: PtyAgentPresenceRecord,
  title: string | null,
  classification: 'agent' | 'management' | 'neutral'
): boolean {
  return (
    agentTitleProvesAgentPresence(title, classification) ||
    (isQuarterCircleSpinnerOnlyAgentTitle(title) &&
      pty.launchAgent === 'claude' &&
      pty.launchToken !== null &&
      pty.launchIncarnationId === pty.incarnationId)
  )
}

export function classifyAgentTitle(title: string | null): 'agent' | 'management' | 'neutral' {
  if (!title) {
    return 'neutral'
  }
  if (isClaudeManagementTitle(title)) {
    return 'management'
  }
  return detectAgentStatusFromTitle(title) !== null ? 'agent' : 'neutral'
}

export function terminalTitleBlocksExplicitAgentStatus(title: string | null): boolean {
  if (!title) {
    return false
  }
  return isClaudeManagementTitle(title) || isShellProcess(title)
}

export function getLatestAgentCandidateTitle(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): string | null {
  return getLatestAgentCandidateTitleInfo(...titles)?.title ?? null
}

export function getLatestAgentCandidateTitleInfo(
  ...titles: { title: string | null | undefined; updatedAt: number | null | undefined }[]
): { title: string; updatedAt: number } | null {
  let latest: { title: string; updatedAt: number } | null = null
  for (const candidate of titles) {
    const title = candidate.title?.trim()
    if (!title) {
      continue
    }
    const updatedAt = candidate.updatedAt ?? 0
    if (!latest || updatedAt > latest.updatedAt) {
      latest = { title, updatedAt }
    }
  }
  return latest
}

export function getSavedTabWorktreeStatus(title: string, hasPty: boolean): RuntimeWorktreeStatus {
  return getDetectedWorktreeStatus(detectAgentStatusFromTitle(title), hasPty)
}

export function getDetectedWorktreeStatus(
  detected: AgentStatus | null,
  hasPty: boolean
): RuntimeWorktreeStatus {
  if (detected === 'permission') {
    return 'permission'
  }
  if (detected === 'working') {
    return 'working'
  }
  return hasPty ? 'active' : 'inactive'
}

export function mapExplicitAgentStateToRuntimeTerminalStatus(
  state: AgentStatusEntry['state']
): NonNullable<RuntimeTerminalAgentStatus['status']> {
  switch (state) {
    case 'blocked':
    case 'waiting':
      return 'permission'
    case 'working':
      return 'working'
    case 'done':
      return 'idle'
  }
}

export function mergeWorktreeStatus(
  current: RuntimeWorktreeStatus,
  next: RuntimeWorktreeStatus
): RuntimeWorktreeStatus {
  return WORKTREE_STATUS_PRIORITY[next] > WORKTREE_STATUS_PRIORITY[current] ? next : current
}

export function mergeWorktreeSummaryStatus(
  summary: RuntimeWorktreePsSummary,
  next: RuntimeWorktreeStatus,
  nextWorkingMode?: RuntimeWorktreePsSummary['workingMode']
): void {
  const currentPriority = WORKTREE_STATUS_PRIORITY[summary.status]
  const nextPriority = WORKTREE_STATUS_PRIORITY[next]
  if (nextPriority > currentPriority) {
    summary.status = next
    if (next === 'working' && nextWorkingMode === 'monitoring') {
      summary.workingMode = 'monitoring'
    } else {
      delete summary.workingMode
    }
    return
  }
  if (nextPriority === currentPriority && next === 'working') {
    if (nextWorkingMode === 'monitoring') {
      summary.workingMode = 'monitoring'
    } else {
      delete summary.workingMode
    }
  }
}

export function maxTimestamp(left: number | null, right: number | null): number | null {
  if (left === null) {
    return right
  }
  if (right === null) {
    return left
  }
  return Math.max(left, right)
}

export function compareWorktreePs(
  left: RuntimeWorktreePsSummary,
  right: RuntimeWorktreePsSummary
): number {
  // Pinned and unread worktrees sort above others so they survive truncation.
  if (left.isPinned !== right.isPinned) {
    return left.isPinned ? -1 : 1
  }
  if (left.unread !== right.unread) {
    return left.unread ? -1 : 1
  }
  // Why: worktree.ps is truncated for mobile, so host-visible activity must sort above inactive rows.
  if (left.hasHostSidebarActivity !== right.hasHostSidebarActivity) {
    return left.hasHostSidebarActivity ? -1 : 1
  }
  const leftLast = left.lastOutputAt ?? -1
  const rightLast = right.lastOutputAt ?? -1
  if (leftLast !== rightLast) {
    return rightLast - leftLast
  }
  if (left.liveTerminalCount !== right.liveTerminalCount) {
    return right.liveTerminalCount - left.liveTerminalCount
  }
  return left.path.localeCompare(right.path)
}
