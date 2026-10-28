import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from '../../shared/workspace-scope'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  isWorktreeHostIdentity
} from '../../shared/worktree/host-qualified-identity'

export function conditionalWorkspaceSessionTargets(
  session: Partial<WorkspaceSessionState>,
  partitionHost: string
): {
  complete: boolean
  targets: { workspaceId: string; hostId: string | undefined }[]
} {
  const targets = new Map<string, { workspaceId: string; hostId: string | undefined }>()
  const incomplete = new Error('conditional_worktree_session_inventory_incomplete')
  const add = (key: string, hostId: string | undefined): void => {
    if (isWorktreeHostIdentity(key) && getExecutionHostIdFromWorktreeHostIdentity(key) !== hostId) {
      hostId = undefined
    }
    const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(key)
    targets.set(JSON.stringify([hostId, workspaceId]), { workspaceId, hostId })
    if (targets.size > 10000) {
      throw incomplete
    }
  }
  try {
    if (session.activeWorktreeId) {
      add(session.activeWorktreeId, partitionHost)
    }
    if (session.activeWorkspaceKey) {
      add(session.activeWorkspaceKey, session.activeWorkspaceExecutionHostId ?? partitionHost)
    }
    for (const workspace of session.activeWorktreeIdsOnShutdown ?? []) {
      add(workspace, partitionHost)
    }
    for (const map of [
      session.tabsByWorktree,
      session.openFilesByWorktree,
      session.browserTabsByWorktree,
      session.browserPagesByWorkspace,
      session.clientHostedBrowserPagesByWorktree,
      session.unifiedTabs
    ]) {
      for (const [workspace, rows] of Object.entries(map ?? {})) {
        if (rows.length) {
          add(workspace, partitionHost)
        }
      }
    }
    for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
      add(record.worktreeId, record.connectionId ? undefined : partitionHost)
    }
  } catch (error) {
    if (error !== incomplete) {
      throw error
    }
    return { complete: false, targets: [] }
  }
  return { complete: true, targets: [...targets.values()] }
}
