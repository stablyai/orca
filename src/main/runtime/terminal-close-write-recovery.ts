import { isDeepStrictEqual } from 'node:util'
import type { ExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { DurableProfileStateMutation } from '../persistence/loading-store/store-runtime-state'
import { cloneWorkspaceSessionState } from '../persistence/restoring-sessions/session-owner-fields'
import { rollbackWorkspaceSessionAfterFailedAsyncWrite } from '../persistence/restoring-sessions/workspace-session-write-rollback'
import { advanceTerminalTopologyRevision } from '../persistence/terminal-topology/terminal-topology-membership'
import type { TerminalSurfaceCloseCommit } from './terminal-surface-close'
import {
  capturePersistedTerminalTabCopy,
  isRetainedTerminalTabRetirementIdentity
} from './workspace-session-terminal-tab-retirement-identity'

/** Compensate only a rejected close, never an ordinary failed write of an accepted user close. */
export function terminalCloseWriteRecovery(
  commit: TerminalSurfaceCloseCommit,
  closed: readonly { hostId: ExecutionHostId; session: WorkspaceSessionState }[]
): Pick<DurableProfileStateMutation<Error | undefined>, 'validate' | 'rollback'> {
  const { requestedHolders, worktreeId, target } = commit
  if (!requestedHolders) {
    return {}
  }
  const writes = closed.map(({ hostId, session }) => ({
    hostId,
    before: session,
    staged: cloneWorkspaceSessionState(commit.getSession(hostId)!)
  }))
  const copyOf = (session: WorkspaceSessionState | null | undefined) =>
    capturePersistedTerminalTabCopy(session, worktreeId, target.tabId)
  const ownerMatches = () =>
    commit.ownerMatches() &&
    commit
      .hostIds()
      .every((hostId) =>
        isRetainedTerminalTabRetirementIdentity(
          requestedHolders.get(hostId) ?? null,
          copyOf(commit.getSession(hostId))
        )
      )
  return {
    validate: () =>
      ownerMatches() ? undefined : { value: new Error('terminal_pane_owner_changed') },
    rollback: () => {
      if (ownerMatches()) {
        return
      }
      for (const { hostId, before, staged } of writes) {
        const current = commit.getSession(hostId)
        // A newer owner or another close must not inherit this close's recovery records.
        if (
          !current ||
          !isRetainedTerminalTabRetirementIdentity(copyOf(before), copyOf(current)) ||
          !isDeepStrictEqual(
            current.closedTerminalTabTombstonesByTabId?.[target.tabId],
            staged.closedTerminalTabTombstonesByTabId?.[target.tabId]
          )
        ) {
          continue
        }
        const restored = rollbackWorkspaceSessionAfterFailedAsyncWrite(
          { ...before, terminalTopologyRevisionByRepoId: staged.terminalTopologyRevisionByRepoId },
          staged,
          current
        )
        if (restored !== current) {
          commit.setSession(advanceTerminalTopologyRevision(restored, worktreeId), hostId)
        }
      }
      // Even a newer owner that needed no restoration must replace the rejected disk snapshot.
      return { persist: true }
    }
  }
}
