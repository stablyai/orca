import { isSyntheticWorkspaceRoute } from '../session/synthetic-workspace-route'
import type { ConnectionState } from '../transport/types'
import type { HomeWorktreeSummary, HostWorktreeInfo } from './home-worktree-info'

// Reserve Resume’s slot from persisted history before connection so Tasks cannot move under the user’s thumb.

export type HomeResumeCard = Readonly<{
  hostId: string
  worktree: HomeWorktreeSummary
  actionable: boolean
}>

export type HomeResumeCardInput = Readonly<{
  /** Home's sorted hosts — order decides which snapshot wins when several have history. */
  hosts: readonly { id: string }[]
  hostStates: Readonly<Record<string, ConnectionState>>
  worktreeInfo: Readonly<Record<string, HostWorktreeInfo>>
  lastVisited: Readonly<{ hostId: string; worktreeId: string }> | null
  cachedWorktrees: (hostId: string) => HomeWorktreeSummary[] | null
}>

function lastVisitedCard({
  lastVisited,
  cachedWorktrees,
  hostStates
}: HomeResumeCardInput): HomeResumeCard | null {
  if (!lastVisited) {
    return null
  }
  const match = cachedWorktrees(lastVisited.hostId)?.find(
    (worktree) => worktree.worktreeId === lastVisited.worktreeId
  )
  if (!match) {
    return null
  }
  return {
    hostId: lastVisited.hostId,
    worktree: match,
    actionable: hostStates[lastVisited.hostId] === 'connected'
  }
}

function hostHistoryCard(
  { hosts, hostStates, worktreeInfo }: HomeResumeCardInput,
  connectedOnly: boolean
): HomeResumeCard | null {
  for (const host of hosts) {
    const worktree = worktreeInfo[host.id]?.lastActiveWorktree
    if (!worktree) {
      continue
    }
    const actionable = hostStates[host.id] === 'connected'
    if (actionable || !connectedOnly) {
      return { hostId: host.id, worktree, actionable }
    }
  }
  return null
}

// Only a proven catalog can establish deletion; cold/loading snapshots leave navigation to the session’s later check.
export function isResumeTargetConfirmedMissing(
  card: Readonly<{ worktree: Readonly<{ worktreeId: string }> }>,
  provenWorktrees: readonly unknown[] | null
): boolean {
  if (!provenWorktrees || isSyntheticWorkspaceRoute(card.worktree.worktreeId)) {
    return false
  }
  return !provenWorktrees.some(
    (worktree) =>
      typeof worktree === 'object' &&
      worktree !== null &&
      'worktreeId' in worktree &&
      worktree.worktreeId === card.worktree.worktreeId
  )
}

export function selectHomeResumeCard(input: HomeResumeCardInput): HomeResumeCard | null {
  const visited = lastVisitedCard(input)
  if (visited?.actionable) {
    return visited
  }
  const connected = hostHistoryCard(input, true)
  if (connected) {
    return connected
  }
  return visited ?? hostHistoryCard(input, false)
}
