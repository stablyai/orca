import { isSyntheticWorkspaceRoute } from '../session/synthetic-workspace-route'
import type { ConnectionState } from '../transport/types'
import type { HomeWorktreeSummary, HostWorktreeInfo } from './home-worktree-info'

// Picks what the home screen's Resume card shows, and whether tapping it can do anything.
// Why the two are separate: gating the card itself on 'connected' made it appear above Tasks
// seconds after first paint, sliding Tasks out from under the user's thumb. A candidate known
// from the persisted snapshot reserves the slot immediately and stays inert until a host connects.

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

/** The worktree last opened on this device, so Resume reflects mobile session history. */
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

/** Whether tapping this card would open a workspace the host has already listed without.
 *  Deliberately one-directional: `provenWorktrees` is null whenever the catalog is a cold-start
 *  snapshot or still loading, and an unproven catalog is not evidence of a deletion — that case
 *  navigates as before and the session screen bounces once the host answers. */
export function isResumeTargetConfirmedMissing(
  card: HomeResumeCard,
  provenWorktrees: readonly { worktreeId: string }[] | null
): boolean {
  if (!provenWorktrees || isSyntheticWorkspaceRoute(card.worktree.worktreeId)) {
    return false
  }
  return !provenWorktrees.some((worktree) => worktree.worktreeId === card.worktree.worktreeId)
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
  // Nothing live to resume yet: hold the slot with whatever the snapshot remembers.
  return visited ?? hostHistoryCard(input, false)
}
