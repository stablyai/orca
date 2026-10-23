import { isSyntheticWorkspaceRoute } from '../session/synthetic-workspace-route'
import type { ConnectionState } from '../transport/types'
import {
  HOME_RECENT_WORKTREE_LIMIT,
  homeWorktreeRecency,
  type HomeWorktreeSummary,
  type HostWorktreeInfo
} from './home-worktree-info'

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

/** Every workspace waiting for permission or an answer, on desktops connected right now. */
export function selectHomeNeedsYou({
  hosts,
  hostStates,
  worktreeInfo
}: HomeResumeCardInput): HomeResumeCard[] {
  return hosts.flatMap((host) => {
    const info = worktreeInfo[host.id]
    // A failed refresh leaves statuses that are no longer live, so they claim nothing.
    if (hostStates[host.id] !== 'connected' || !info || info.catalogUnavailable) {
      return []
    }
    return (info.permissionWorktrees ?? []).map((worktree) => ({
      hostId: host.id,
      worktree,
      actionable: true
    }))
  })
}

function cardKey(card: HomeResumeCard): string {
  return JSON.stringify([card.hostId, card.worktree.worktreeId])
}

/** Up to three workspaces to go back to: the Resume pick first, then the latest across desktops. */
export function selectHomeJumpBackIn(
  input: HomeResumeCardInput,
  exclude: readonly HomeResumeCard[]
): HomeResumeCard[] {
  const taken = new Set(exclude.map(cardKey))
  const picked: HomeResumeCard[] = []
  const add = (card: HomeResumeCard): void => {
    const key = cardKey(card)
    if (picked.length < HOME_RECENT_WORKTREE_LIMIT && !taken.has(key)) {
      taken.add(key)
      picked.push(card)
    }
  }
  const resume = selectHomeResumeCard(input)
  if (resume) {
    add(resume)
  }
  const recent = input.hosts.flatMap((host) =>
    (input.worktreeInfo[host.id]?.recentWorktrees ?? []).map((worktree) => ({
      hostId: host.id,
      worktree,
      actionable: input.hostStates[host.id] === 'connected'
    }))
  )
  recent.sort(
    (a, b) =>
      Number(b.actionable) - Number(a.actionable) ||
      homeWorktreeRecency(b.worktree) - homeWorktreeRecency(a.worktree)
  )
  for (const card of recent) {
    add(card)
  }
  return picked
}
