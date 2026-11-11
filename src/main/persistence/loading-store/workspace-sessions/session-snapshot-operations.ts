import type { PersistedState } from '../../../../shared/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { pruneWorkspaceSessionBrowserHistory } from '../../../../shared/workspace-session/workspace-session-browser-history'

import {
  workspaceSessionPatchNeedsFullNormalization,
  prepareWorkspaceSessionTopologyPatch
} from './terminal-session-cleanup'
import { rebaseWorkspaceSessionTerminalGroupPatch } from '../../../runtime/terminal/surface/workspace-session-terminal-membership-authority'

import { setLocalWorkspaceSession } from './workspace-session-snapshot-publication'
import type { TerminalBindingRecoveryOperations } from '../terminal-bindings/terminal-binding-recovery'
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
import { dropClosedTerminalTabs } from '../../closed-terminal-tab-write-fence'
import { keepWslMoveFrozenSessionsForStore } from '../../moving-wsl-projects/terminal-state/wsl-move-session-freeze'
import { type WriteSchedulingOperations, scheduleSave } from '../profile-writing/write-scheduling'
import { orderTerminalRowsByTabGroups } from '../../../../shared/workspace-layout/terminal-row-order'

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
    const prior = this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved)
    // Scalar patches skip topology work; membership patches retain stale-binding protections.
    let next: WorkspaceSessionState = {
      ...prior,
      ...patch
    }
    if (workspaceSessionPatchNeedsFullNormalization(patch)) {
      this.setWorkspaceSession(next, resolved)
      return
    }
    const topology = prepareWorkspaceSessionTopologyPatch(patch, prior)
    const topologyWorktrees = topology.worktreeIds
    next = { ...prior, ...topology.patch }
    // Mirrored runtime partitions retain their existing timed full-snapshot fence.
    if (topologyWorktrees.size > 0 && parseExecutionHostId(resolved)?.kind !== 'runtime') {
      next = rebaseWorkspaceSessionTerminalGroupPatch(next, prior, topologyWorktrees)
    }
    if (Object.hasOwn(patch, 'browserUrlHistory')) {
      next = pruneWorkspaceSessionBrowserHistory(next)
    }
    // Unified-tab patches bypass full normalization but still need close tombstones.
    if (Object.hasOwn(patch, 'unifiedTabs')) {
      next = dropClosedTerminalTabs(next)
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      const { state } = this[sessionSnapshotOperationsContext].runtime
      next = keepWslMoveFrozenSessionsForStore(next, state.workspaceSession)
    }
    this.publishSession(next, resolved, topologyWorktrees)
  }

  private publishSession(
    session: WorkspaceSessionState,
    hostId: ExecutionHostId,
    worktreeIds?: ReadonlySet<string>
  ): void {
    session = orderTerminalRowsByTabGroups(session, worktreeIds)
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
