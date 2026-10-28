import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-session-contracts'
import type { createConditionalWorkspaceMatcher } from './conditional-workspace-presence'
import { conditionalWorkspaceSessionTargets } from '../ipc/conditional-workspace-session-targets'

type MatchWorkspace = ReturnType<typeof createConditionalWorkspaceMatcher>
type Presence = 'idle' | 'live' | 'unknown'
type Snapshot = Pick<
  RuntimeMobileSessionTabsResult,
  | 'worktree'
  | 'tabs'
  | 'initialSurfaceLaunch'
  | 'agentSessionsUnverifiable'
  | 'clientHostedPagesUnreconciled'
>

export function conditionalSnapshotWorkspacePresence(
  snapshots: readonly Snapshot[],
  match: MatchWorkspace,
  resolveHost: (workspaceId: string) => string | undefined
): Presence {
  if (snapshots.length > 10000) {
    return 'unknown'
  }
  for (const snapshot of snapshots) {
    if (
      !snapshot.tabs.length &&
      !snapshot.initialSurfaceLaunch &&
      !snapshot.agentSessionsUnverifiable &&
      !snapshot.clientHostedPagesUnreconciled
    ) {
      continue
    }
    const matches = match(snapshot.worktree, resolveHost(snapshot.worktree))
    if (matches === 'unknown') {
      return 'unknown'
    }
    if (matches === 'different') {
      continue
    }
    if (snapshot.agentSessionsUnverifiable || snapshot.clientHostedPagesUnreconciled) {
      return 'unknown'
    }
    return 'live'
  }
  return 'idle'
}

export function conditionalSessionWorkspacePresence(
  session: Partial<WorkspaceSessionState>,
  hostId: string,
  match: MatchWorkspace
): Presence {
  try {
    const inventory = conditionalWorkspaceSessionTargets(session, hostId)
    if (!inventory.complete) {
      return 'unknown'
    }
    for (const target of inventory.targets) {
      const matches = match(target.workspaceId, target.hostId)
      if (matches === 'unknown') {
        return 'unknown'
      }
      if (matches === 'same') {
        return 'live'
      }
    }
  } catch {
    return 'unknown'
  }
  return 'idle'
}
