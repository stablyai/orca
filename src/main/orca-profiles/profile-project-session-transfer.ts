import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { rekeyOwnerKey, rekeyWorktreeId } from './profile-project-worktree-identity'
import {
  extractSessionOwnersForTransfer,
  hasTransferredSessionState
} from './profile-session-owner-transfer'

export function extractHostSessionsForTransfer(
  sessions: Partial<Record<ExecutionHostId, WorkspaceSessionState>> | undefined,
  oldRepoId: string,
  newRepoId: string
): Partial<Record<ExecutionHostId, WorkspaceSessionState>> {
  const next: Partial<Record<ExecutionHostId, WorkspaceSessionState>> = {}
  for (const [hostId, session] of Object.entries(sessions ?? {})) {
    if (!session) {
      continue
    }
    const transferred = extractSessionForTransfer(session, oldRepoId, newRepoId)
    if (hasTransferredSessionState(transferred)) {
      next[hostId as ExecutionHostId] = transferred
    }
  }
  return next
}

export function extractSessionForTransfer(
  session: WorkspaceSessionState | undefined,
  oldRepoId: string,
  newRepoId: string
): WorkspaceSessionState {
  return extractSessionOwnersForTransfer(session, {
    mapOwnerKey: (ownerKey) => rekeyOwnerKey(oldRepoId, newRepoId, ownerKey),
    mapWorktreeId: (worktreeId) => rekeyWorktreeId(oldRepoId, newRepoId, worktreeId)
  })
}
