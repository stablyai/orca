import { reconcileTrackedPtyBindingGenerations } from '../terminal-bindings/pty-binding-generations'
import type { PersistedState } from '../../../../shared/orca-profiles/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../../shared/workspace-session/workspace-session-state-types'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import { pruneWorkspaceSessionBrowserHistory } from '../../../../shared/workspace-session/workspace-session-browser-history'

import { workspaceSessionPatchNeedsFullNormalization } from './terminal-session-cleanup'

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
import {
  membershipRewritesFor,
  withStoreRewrites,
  type WrittenWorkspaceScope
} from './workspace-session-write-listeners'
import { orderTerminalRowsByTabGroups } from '../../../../shared/workspace-layout/terminal-topology/terminal-row-order'
import { rowShareRef } from '../../../../shared/workspace-layout/persistence/workspace-layout-load-slice'

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

  /** `written`: the workspaces the caller changed, when it knows them; the Store's own rewrites can still widen it. */
  setWorkspaceSession(
    session: PersistedState['workspaceSession'],
    hostId?: string | null,
    written?: WrittenWorkspaceScope
  ): void {
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
      setLocalWorkspaceSession(this, session, false, written)
      return
    }
    setHostWorkspaceSession(
      this[sessionSnapshotOperationsContext].sessions,
      resolved,
      session,
      written
    )
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

  patchWorkspaceSession(
    patch: WorkspaceSessionPatch,
    hostId?: string | null,
    written?: WrittenWorkspaceScope
  ): void {
    const resolved = resolveHostId(hostId)
    // Scalar patches skip topology work; membership patches retain stale-binding protections.
    let next: WorkspaceSessionState = {
      ...this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved),
      ...patch
    }
    if (workspaceSessionPatchNeedsFullNormalization(patch)) {
      this.setWorkspaceSession(next, resolved, written)
      return
    }
    if (Object.hasOwn(patch, 'browserUrlHistory')) {
      next = pruneWorkspaceSessionBrowserHistory(next)
    }
    const rewrites = membershipRewritesFor(written)
    // Unified-tab patches bypass full normalization but still need close tombstones.
    if (Object.hasOwn(patch, 'unifiedTabs')) {
      next = dropClosedTerminalTabs(next, undefined, rewrites?.worktreeIds)
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      const { state } = this[sessionSnapshotOperationsContext].runtime
      next = keepWslMoveFrozenSessionsForStore(next, state.workspaceSession)
    }
    this.publishSession(next, resolved, written, rewrites)
  }

  /** Relay ids and their ownership only: no rows change, so topology is untouched, and listeners hear
   *  only about the tabs whose relay ids changed. */
  patchWorkspaceSessionRelays(
    patch: Pick<
      WorkspaceSessionPatch,
      'remoteSessionIdsByTabId' | 'desktopRelayOwnerByTabId' | 'desktopRelayAdoptionVersion'
    >,
    hostId: string | null | undefined,
    changedTabIds: readonly string[]
  ): void {
    const resolved = resolveHostId(hostId)
    const session = this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved)
    let next: WorkspaceSessionState = { ...session, ...patch }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      next = keepWslMoveFrozenSessionsForStore(next, session)
    }
    const written = { workspaces: new Set<string>(), refs: new Set(changedTabIds.map(rowShareRef)) }
    this.publishSession(next, resolved, written, undefined, false)
  }

  /** Drops one pane's saved resume when `retire` accepts it. Topology is untouched, so rows keep
   *  their order and the next coalesced save persists it. */
  retireSleepingAgentSession(
    paneKey: string,
    retire: (saved: SleepingAgentSessionRecord) => boolean,
    hostId?: string | null
  ): boolean {
    const resolved = resolveHostId(hostId)
    const session = this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(resolved)
    const records = session.sleepingAgentSessionsByPaneKey
    const saved = records?.[paneKey]
    if (!records || !saved || !retire(saved)) {
      return false
    }
    this.assertSnapshotAdmission()
    const { [paneKey]: _retired, ...kept } = records
    let next: WorkspaceSessionState = { ...session, sleepingAgentSessionsByPaneKey: kept }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      next = keepWslMoveFrozenSessionsForStore(next, session)
    }
    this.publishSession(next, resolved, undefined, undefined, false)
    return true
  }

  /** `rewrites` collects what the Store's own normalization changed for a scoped write. */
  private publishSession(
    session: WorkspaceSessionState,
    hostId: ExecutionHostId,
    written?: WrittenWorkspaceScope,
    rewrites = membershipRewritesFor(written),
    topologyChanged = true
  ): void {
    if (topologyChanged) {
      session = orderTerminalRowsByTabGroups(session, rewrites?.worktreeIds)
    }
    const { runtime, scheduling } = this[sessionSnapshotOperationsContext]
    reconcileTrackedPtyBindingGenerations(
      runtime,
      hostId,
      this[sessionSnapshotOperationsContext].sessions.getWorkspaceSession(hostId),
      session
    )
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
      hostId,
      withStoreRewrites(written, rewrites)
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
