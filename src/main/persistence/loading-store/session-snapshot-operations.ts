import { retireRemovedScopedTerminalRow } from '../../pty/legacy-terminal-retirement'
import { legacyTerminalIdentityClaims } from './legacy-terminal-identity-claims'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session/workspace-session-browser-history'

import { workspaceSessionPatchNeedsFullNormalization } from './terminal-session-cleanup'

import { setLocalWorkspaceSession } from './workspace-session-snapshot-publication'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import {
  sessionSnapshotOperationsContext,
  type SessionSnapshotOperationsContext,
  type SessionSnapshotOperationsRuntime
} from './session-snapshot-operations-context'

import {
  type SessionHostPartitionOperations,
  resolveHostId,
  setHostWorkspaceSession,
  withRequiredWorkspaceSessionMaps
} from './session-host-partitions'
import { dropClosedTerminalTabs } from '../closed-terminal-tab-write-fence'
import { keepWslMoveFrozenSessionsForStore } from '../moving-wsl-projects/wsl-move-session-freeze'
import { type WriteSchedulingOperations, scheduleSave } from './write-scheduling'
import { orderTerminalRowsByTabGroups } from '../../../shared/workspace-layout/terminal-row-order'

export class SessionSnapshotOperations {
  readonly [sessionSnapshotOperationsContext]: SessionSnapshotOperationsContext

  constructor(
    runtime: SessionSnapshotOperationsRuntime,
    sessions: SessionHostPartitionOperations,
    bindingRecovery: TerminalBindingRecoveryOperations,
    scheduling: WriteSchedulingOperations
  ) {
    this[sessionSnapshotOperationsContext] = { runtime, sessions, bindingRecovery, scheduling }
  }

  setWorkspaceSession(session: PersistedState['workspaceSession'], hostId?: string | null): void {
    const resolved = resolveHostId(hostId)
    const { runtime } = this[sessionSnapshotOperationsContext]
    if (runtime.durableMutationPhase === 'rollback') {
      this.assertSnapshotAdmission(true)
      // The fieldwise rollback already preserves newer edits; renderer rebasing would undo it.
      this.publishSession(
        resolved === LOCAL_EXECUTION_HOST_ID
          ? keepWslMoveFrozenSessionsForStore(session, runtime.state.workspaceSession)
          : session,
        resolved
      )
      return
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.assertSnapshotAdmission(true)
      setLocalWorkspaceSession(this, session)
      return
    }
    setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
  }

  stageWorkspaceSessionBeforeUnload(
    session: PersistedState['workspaceSession'],
    hostId?: string | null
  ): void {
    const resolved = resolveHostId(hostId)
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      this.assertSnapshotAdmission()
      setLocalWorkspaceSession(this, session, true)
      return
    }
    setHostWorkspaceSession(this[sessionSnapshotOperationsContext].sessions, resolved, session)
  }

  patchWorkspaceSession(patch: WorkspaceSessionPatch, hostId?: string | null): void {
    const resolved = resolveHostId(hostId)
    // Scalar patches skip topology work; membership patches retain stale-binding protections.
    let next: WorkspaceSessionState = {
      ...this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved),
      ...patch
    }
    if (workspaceSessionPatchNeedsFullNormalization(patch)) {
      this.setWorkspaceSession(next, resolved)
      return
    }
    if (Object.hasOwn(patch, 'browserUrlHistory')) {
      next = pruneWorkspaceSessionBrowserHistory(next)
    }
    const removed = new Map<string, Set<string>>()
    const remove = (workspace: string, id: string) => {
      const ids = removed.get(workspace) ?? new Set<string>()
      ids.add(id)
      removed.set(workspace, ids)
    }
    const prior = this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved)
    if (Object.hasOwn(patch, 'unifiedTabs')) {
      next = dropClosedTerminalTabs(next, Date.now(), remove)
      for (const [workspace, tabs] of Object.entries(prior.unifiedTabs ?? {})) {
        const accepted = next.unifiedTabs?.[workspace]
        if (!accepted) {
          continue
        }
        const shown = new Set(
          accepted.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
        )
        for (const tab of tabs) {
          if (tab.contentType === 'terminal' && !shown.has(tab.entityId)) {
            remove(workspace, tab.entityId)
          }
        }
      }
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      const { runtime } = this[sessionSnapshotOperationsContext]
      next = keepWslMoveFrozenSessionsForStore(next, runtime.state.workspaceSession)
      const claims = legacyTerminalIdentityClaims(runtime)
      if (claims) {
        for (const [workspace, ids] of removed) {
          if (!claims.isLocalWorkspace(workspace)) {
            continue
          }
          const beforeShown = new Set(
            (prior.unifiedTabs?.[workspace] ?? [])
              .filter((tab) => tab.contentType === 'terminal')
              .map((tab) => tab.entityId)
          )
          const accepted = next.unifiedTabs?.[workspace]
          const shown = accepted
            ? new Set(
                accepted.filter((tab) => tab.contentType === 'terminal').map((tab) => tab.entityId)
              )
            : undefined
          for (const id of ids) {
            const survives =
              !!next.terminalLayoutsByTabId?.[id]?.root &&
              !(shown && beforeShown.has(id) && !shown.has(id))
            if (!survives) {
              retireRemovedScopedTerminalRow(claims, workspace, { id }, prior, next, false)
            }
          }
        }
      }
    }
    this.publishSession(next, resolved)
  }

  private publishSession(session: WorkspaceSessionState, hostId: ExecutionHostId): void {
    session = orderTerminalRowsByTabGroups(session)
    const { runtime, scheduling } = this[sessionSnapshotOperationsContext]
    if (hostId === LOCAL_EXECUTION_HOST_ID) {
      runtime.state.workspaceSession = session
    } else {
      runtime.state.workspaceSessionsByHostId = {
        ...runtime.state.workspaceSessionsByHostId,
        [hostId]: withRequiredWorkspaceSessionMaps(session)
      }
    }
    scheduleSave(
      scheduling,
      hostId === LOCAL_EXECUTION_HOST_ID ? ['workspaceSession'] : ['workspaceSessionsByHostId'],
      hostId
    )
  }

  private assertSnapshotAdmission(allowAdmittedMutation = false): void {
    const { runtime } = this[sessionSnapshotOperationsContext]
    if (
      runtime.writesFrozen ||
      ((runtime.profileMaintenancePending || runtime.quitFlushStarted) &&
        !(allowAdmittedMutation && runtime.durableMutationPhase !== null))
    ) {
      throw new Error('Profile maintenance or finalization is blocking new terminal snapshot work')
    }
  }
}
