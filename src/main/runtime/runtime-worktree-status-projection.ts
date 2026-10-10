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

type TitleCandidate = { title: string | null | undefined; updatedAt: number | null | undefined }

type PtyAgentPresenceRecord = {
  launchAgent: TuiAgent | null
  launchToken: string | null
  launchIncarnationId: PtyIncarnationId | null
  incarnationId: PtyIncarnationId | null
}

/** The stale-working timer's display-only clear of a PTY's native title, while it stands. */
export type TitleDisplayClear = {
  title: string
  status: AgentStatus | null
  /** Dated as a genuine title would be: observation sequence and wall clock. */
  observedAt: number
  observedAtEpochMs: number
}

type PtyTitleEvidence = PtyTitleRecord & {
  lastOscTitleEpochMs: number | null
  lastAgentStatus: AgentStatus | null
  lastAgentStatusStartedAtEpochMs: number | null
}

/**
 * A PTY record as display surfaces show it. Records keep the agent's own title for readiness,
 * delivery and presence; display readers project through here so they show the cleared title
 * the tab shows. Why max(): a restore seed re-stamps the native title after the clear.
 */
export function getPtyDisplayRecord<T extends PtyTitleEvidence>(
  pty: T,
  clear: TitleDisplayClear | null
): T {
  if (!clear) {
    return pty
  }
  return {
    ...pty,
    lastOscTitle: clear.title,
    lastOscTitleAt: Math.max(pty.lastOscTitleAt ?? 0, clear.observedAt),
    lastOscTitleEpochMs: clear.observedAtEpochMs,
    lastAgentStatus: clear.status,
    lastAgentStatusStartedAtEpochMs:
      clear.status === pty.lastAgentStatus
        ? pty.lastAgentStatusStartedAtEpochMs
        : clear.observedAtEpochMs
  }
}

/** The leaf counterpart of {@link getPtyDisplayRecord}; `clear` is its PTY's. */
export function getLeafDisplayRecord<T extends LeafStatusRecord>(
  leaf: T,
  clear: TitleDisplayClear | null
): T {
  if (!clear) {
    return leaf
  }
  return {
    ...leaf,
    lastOscTitle: clear.title,
    lastOscTitleAt: Math.max(leaf.lastOscTitleAt ?? 0, clear.observedAt),
    lastAgentStatus: clear.status
  }
}

/**
 * The prompt lifecycle as display shows it. Main recorded the clear's status there as well, so a
 * title snapshot projected through the clear is only comparable with a lifecycle projected the
 * same way. Display, blocked-dialog checks and prompt-submission verification read it; readiness
 * and delivery never do.
 */
export function getDisplayPromptLifecycle(
  lifecycle: { status: AgentStatus | null; updatedAt: number } | null | undefined,
  clear: TitleDisplayClear | null
): { status: AgentStatus | null; updatedAt: number } | null | undefined {
  if (!clear || (lifecycle && lifecycle.updatedAt > clear.observedAtEpochMs)) {
    return lifecycle
  }
  return { status: clear.status, updatedAt: clear.observedAtEpochMs }
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
  ...titles: TitleCandidate[]
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

export function getLatestAgentCandidateTitle(...titles: TitleCandidate[]): string | null {
  return getLatestAgentCandidateTitleInfo(...titles)?.title ?? null
}

export function getLatestAgentCandidateTitleInfo(
  ...titles: TitleCandidate[]
): { title: string; updatedAt: number } | null {
  const latest = getLatestAgentCandidate(...titles)
  const title = latest?.title?.trim()
  return latest && title ? { title, updatedAt: latest.updatedAt ?? 0 } : null
}

/** The newest non-blank candidate itself, so a caller can tell which source won. */
export function getLatestAgentCandidate<T extends TitleCandidate>(...candidates: T[]): T | null {
  let latest: T | null = null
  for (const candidate of candidates) {
    if (!candidate.title?.trim()) {
      continue
    }
    if (!latest || (candidate.updatedAt ?? 0) > (latest.updatedAt ?? 0)) {
      latest = candidate
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
