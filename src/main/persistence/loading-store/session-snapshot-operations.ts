import { applyWorkspacePresentationCommand } from './workspace-presentation-command'
import type { LayoutCommand } from '../../../shared/workspace-layout/workspace-layout-command-types'
import {
  presentationMutation,
  storedWorkspacePresentations,
  writeWorkspacePresentation
} from './workspace-presentation-publication'
import {
  readWorkspacePresentations,
  isWorkspacePresentationKey,
  type WorkspacePresentationCommit
} from '../../../shared/workspace-presentation'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type {
  WorkspaceSessionPatch,
  WorkspaceSessionState
} from '../../../shared/workspace-session-state-types'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { pruneWorkspaceSessionBrowserHistory } from '../../../shared/workspace-session-browser-history'

import { workspaceSessionPatchNeedsFullNormalization } from './terminal-session-cleanup'

import { setLocalWorkspaceSession } from './workspace-session-snapshot-publication'
import type { StoreRuntimeState } from './store-runtime-state'
import type { SessionHostPartitionOperations } from './session-host-partitions'
import type { TerminalBindingRecoveryOperations } from './terminal-binding-recovery'
import type { WriteSchedulingOperations } from './write-scheduling'
import {
  resolveHostId,
  setHostWorkspaceSession,
  withRequiredWorkspaceSessionMaps
} from './session-host-partitions'
import { dropClosedTerminalTabs } from '../closed-terminal-tab-write-fence'
import { keepWslMoveFrozenSessionsForStore } from '../moving-wsl-projects/wsl-move-session-freeze'
import { scheduleSave } from './write-scheduling'
import { orderTerminalRowsByTabGroups } from '../../../shared/workspace-layout/terminal-row-order'

type SessionSnapshotOperationsRuntime = Pick<
  StoreRuntimeState,
  | 'durableMutationPhase'
  | 'pendingSnapshotFileWork'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'state'
  | 'runDurableMutation'
  | 'terminalScrollbackSnapshotStorage'
  | 'retainedScrollbackRefsByMigrationId'
  | 'writesFrozen'
>

const sessionSnapshotOperationsContext = Symbol('SessionSnapshotOperations')
type SessionSnapshotOperationsContext = {
  runtime: SessionSnapshotOperationsRuntime
  sessions: SessionHostPartitionOperations
  bindingRecovery: TerminalBindingRecoveryOperations
  scheduling: WriteSchedulingOperations
}

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

  applyWorkspacePresentationCommand(command: LayoutCommand) {
    const { runtime, scheduling } = this[sessionSnapshotOperationsContext]
    return applyWorkspacePresentationCommand(runtime, scheduling, command)
  }

  getWorkspacePresentations(keys?: readonly string[]) {
    return storedWorkspacePresentations(this[sessionSnapshotOperationsContext].runtime.state, keys)
  }

  stageWorkspacePresentationCommit(
    commit: WorkspacePresentationCommit,
    beforeUnload = false
  ): void {
    this.assertSnapshotAdmission(true)
    const { runtime, scheduling } = this[sessionSnapshotOperationsContext]
    const documents = readWorkspacePresentations(commit.presentations)
    if (Object.keys(documents).length !== Object.keys(commit.presentations).length) {
      throw new Error('Invalid workspace presentation')
    }
    const finish = presentationMutation(runtime.state)
    const local = runtime.state.workspaceSession
    const hosts = runtime.state.workspaceSessionsByHostId
    try {
      // Stage U first: the source adapter compares incoming records against this same captured base.
      const dirty: string[] = []
      const removed = new Set(commit.removedPresentations ?? [])
      if (commit.replacePresentations) {
        for (const key of Object.keys(this.getWorkspacePresentations())) {
          if (isWorkspacePresentationKey(key) && !documents[key]) {
            removed.add(key)
          }
        }
      }
      for (const key of removed) {
        if (!isWorkspacePresentationKey(key)) {
          throw new Error('Invalid workspace presentation key')
        }
        writeWorkspacePresentation(runtime.state, key, undefined)
        dirty.push(key)
      }
      for (const [key, value] of Object.entries(documents)) {
        if (isWorkspacePresentationKey(key) && value) {
          writeWorkspacePresentation(runtime.state, key, value)
          dirty.push(key)
        }
      }
      for (const { state, hostId } of commit.sessions) {
        if (commit.mode === 'patch') {
          this.patchWorkspaceSession(state, hostId)
        } else if (beforeUnload) {
          this.stageWorkspaceSessionBeforeUnload(state, hostId)
        } else {
          this.setWorkspaceSession(state, hostId)
        }
      }
      if (dirty.length) {
        scheduleSave(scheduling, dirty)
      }
    } catch (error) {
      runtime.state.workspaceSession = local
      runtime.state.workspaceSessionsByHostId = hosts
      finish()()
      throw error
    }
    finish()
  }

  commitWorkspacePresentation(commit: WorkspacePresentationCommit): Promise<void> {
    const { runtime } = this[sessionSnapshotOperationsContext]
    return runtime.runDurableMutation(() => {
      const local = runtime.state.workspaceSession
      const hosts = runtime.state.workspaceSessionsByHostId
      this.stageWorkspacePresentationCommit(commit)
      const writtenLocal = runtime.state.workspaceSession
      const writtenHosts = runtime.state.workspaceSessionsByHostId
      return {
        value: undefined,
        rollback: () => {
          if (runtime.state.workspaceSession === writtenLocal) {
            runtime.state.workspaceSession = local
          }
          if (runtime.state.workspaceSessionsByHostId === writtenHosts) {
            runtime.state.workspaceSessionsByHostId = hosts
          }
        }
      }
    })
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
    // Unified-tab patches bypass full normalization but still need close tombstones.
    if (Object.hasOwn(patch, 'unifiedTabs')) {
      next = dropClosedTerminalTabs(next)
    }
    if (resolved === LOCAL_EXECUTION_HOST_ID) {
      const { state } = this[sessionSnapshotOperationsContext].runtime
      next = keepWslMoveFrozenSessionsForStore(next, state.workspaceSession)
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

export function getSessionSnapshotOperationsContext(owner: SessionSnapshotOperations) {
  return owner[sessionSnapshotOperationsContext]
}
